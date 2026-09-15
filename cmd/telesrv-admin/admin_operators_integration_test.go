package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"telesrv/internal/admin"
)

// The operator-account and audit-log machinery is a thin layer over Postgres
// (the accounts table, the audit tables), so the session-revocation contract,
// the store writes and the list endpoints can only be proven against the real
// schema. Gated on TELESRV_TEST_POSTGRES_DSN like the other integration tests.
//
// These are deliberately end-to-end through the routed server where the
// behaviour being pinned is the HTTP surface (login signing, per-request
// re-read, list responses), and directly against the store methods where they
// are smaller (guard, uniqueness, audit trail).

func operatorServer(t *testing.T) (*server, *readStore) {
	t.Helper()
	store, _ := verificationReadStore(t)
	srv, err := newServer(uiConfig{
		SessionKey:  []byte(testSessionKey),
		Password:    "letmein",
		Permissions: []string{permissionAll},
	}, store, nil)
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	return srv, store
}

// namedSignIn is signIn for a database-backed operator: the same routes, the
// same cookie+csrf pairing, just a real account instead of the break-glass one.
func namedSignIn(t *testing.T, srv *server, username, secret string) ([]*http.Cookie, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(
		fmt.Sprintf(`{"username":%q,"secret":%q}`, username, secret)))
	srv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login(%s) status=%d body=%s", username, rec.Code, rec.Body.String())
	}
	var body struct {
		Actor     string `json:"actor"`
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if body.Actor != username || body.CSRFToken == "" {
		t.Fatalf("login body=%s", rec.Body.String())
	}
	return rec.Result().Cookies(), body.CSRFToken
}

func TestNamedOperatorLoginAndSessionRevocation(t *testing.T) {
	srv, store := operatorServer(t)
	pool := store.pool
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	username := "alice" + suffix
	secret := "first-secret-" + suffix
	next := "second-secret-" + suffix
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM admin_console_users WHERE username = $1`, username)
	})

	user, err := srv.createAdminConsoleUser(ctx, username, secret, []string{permissionAdminsManage, permissionAuditRead}, true)
	if err != nil {
		t.Fatalf("create operator: %v", err)
	}
	if user.TokenEpoch != 1 {
		t.Fatalf("new operator epoch=%d, want 1", user.TokenEpoch)
	}

	// A fresh account signs in and its session is usable.
	cookies, _ := namedSignIn(t, srv, username, secret)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/session", nil), cookies))
	if rec.Code != http.StatusOK {
		t.Fatalf("session status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}

	// Changing the password bumps token_epoch, which retires every session that
	// was signed with the old epoch on their very next request.
	if err := srv.setAdminConsoleUserPassword(ctx, user.ID, next); err != nil {
		t.Fatalf("set password: %v", err)
	}
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/session", nil), cookies))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old-password session status=%d, want 401 after password change", rec.Code)
	}

	// The old secret no longer authenticates; the new one does.
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(
		fmt.Sprintf(`{"username":%q,"secret":%q}`, username, secret))))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old secret status=%d, want 401", rec.Code)
	}
	cookies2, _ := namedSignIn(t, srv, username, next)

	// Disabling the account signs it out too, even though the cookie itself is
	// still cryptographically valid: the per-request re-read sees the row is not
	// enabled and refuses.
	if _, err := srv.updateAdminConsoleUser(ctx, user.ID, []string{permissionAdminsManage, permissionAuditRead}, false); err != nil {
		t.Fatalf("disable operator: %v", err)
	}
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/session", nil), cookies2))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled session status=%d, want 401", rec.Code)
	}

	// And a disabled account cannot even log in again.
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(
		fmt.Sprintf(`{"username":%q,"secret":%q}`, username, next))))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled login status=%d, want 401", rec.Code)
	}
}

func TestDemotionAppliesFromTheNextRequestWithoutSigningOut(t *testing.T) {
	srv, store := operatorServer(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	username := "bob" + suffix
	t.Cleanup(func() {
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE username = $1`, username)
	})

	secret := "secret-" + suffix
	user, err := srv.createAdminConsoleUser(ctx, username, secret, []string{permissionAdminsManage, permissionAuditRead}, true)
	if err != nil {
		t.Fatalf("create operator: %v", err)
	}
	cookies, _ := namedSignIn(t, srv, username, secret)

	// With both rights, the audit log answers.
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/audit-logs", nil), cookies))
	if rec.Code != http.StatusOK {
		t.Fatalf("audit read status=%d, want 200 before demotion", rec.Code)
	}

	// Drop audit.read but keep the account enabled. The already-signed-in
	// session is not terminated (the epoch moved for no reason), but its rights
	// are re-read every request, so the audit route now refuses without a
	// re-login.
	if _, err := srv.updateAdminConsoleUser(ctx, user.ID, []string{permissionAdminsManage}, true); err != nil {
		t.Fatalf("demote operator: %v", err)
	}
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/audit-logs", nil), cookies))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("audit read after demotion status=%d, want 403", rec.Code)
	}
	// The session itself is still alive and the operator list still works.
	rec = httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/admin-users", nil), cookies))
	if rec.Code != http.StatusOK {
		t.Fatalf("admin-users after demotion status=%d, want 200", rec.Code)
	}
	var list struct {
		System map[string]any `json:"system"`
		Rows   int            `json:"-"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if list.System["username"] != breakGlassUsername {
		t.Fatalf("admin-users response omitted the system operator: %s", rec.Body.String())
	}
}

func TestOperatorUniquenessAndLastManagerGuard(t *testing.T) {
	srv, store := operatorServer(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	name := func(prefix string) string { return prefix + suffix }
	users := []string{name("solo"), name("buddy"), name("DupUser"), name("dupuser")}
	for _, u := range users {
		t.Cleanup(func() {
			_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE username = $1`, u)
		})
	}

	pw := "password-" + suffix
	type row struct {
		id   int64
		name string
	}
	var (
		solo   row
		buddy  row
		dupOne row
	)

	u, err := srv.createAdminConsoleUser(ctx, name("solo"), pw, []string{permissionAdminsManage}, true)
	if err != nil {
		t.Fatalf("create solo: %v", err)
	}
	solo.id, solo.name = u.ID, u.Username

	// Removing the only manager's capability, or disabling the only manager, is
	// refused rather than left to be discovered after a lockdown.
	if err := srv.guardManagerRemoval(ctx, solo.id, []string{}, false); !errors.Is(err, errLastManagerStanding) {
		t.Fatalf("last manager guard err=%v, want errLastManagerStanding", err)
	}
	if err := srv.guardManagerRemoval(ctx, solo.id, []string{permissionAccountsRead}, true); !errors.Is(err, errLastManagerStanding) {
		t.Fatalf("self-demotion guard err=%v, want errLastManagerStanding", err)
	}

	// With a second manager present the same edit is allowed.
	u, err = srv.createAdminConsoleUser(ctx, name("buddy"), pw, []string{permissionAdminsManage}, true)
	if err != nil {
		t.Fatalf("create buddy: %v", err)
	}
	buddy.id, buddy.name = u.ID, u.Username
	if err := srv.guardManagerRemoval(ctx, solo.id, []string{}, false); err != nil {
		t.Fatalf("guard with a second manager err=%v, want nil", err)
	}

	// The unique index is on lower(username), so a differently-cased duplicate
	// is refused rather than allowed to shadow the original.
	u, err = srv.createAdminConsoleUser(ctx, name("DupUser"), pw, []string{permissionAdminsManage}, true)
	if err != nil {
		t.Fatalf("create DupUser: %v", err)
	}
	dupOne.id, dupOne.name = u.ID, u.Username
	if _, err := srv.createAdminConsoleUser(ctx, name("dupuser"), pw, []string{permissionAdminsManage}, true); !errors.Is(err, errAdminUsernameTaken) {
		t.Fatalf("cased duplicate err=%v, want errAdminUsernameTaken", err)
	}

	// Leftovers that could trip other runs are removed.
	t.Cleanup(func() {
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE id = $1`, dupOne.id)
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE id = $1`, buddy.id)
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE id = $1`, solo.id)
	})
	if buddy.name == "" || solo.name == "" || dupOne.name == "" {
		t.Fatal("fixture rows were not created")
	}
}

func TestAuditTrailRecordsAndListsThroughTheRoutes(t *testing.T) {
	srv, store := operatorServer(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	operator := "carol" + suffix
	password := "password-" + suffix

	t.Cleanup(func() {
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_console_users WHERE username = $1`, operator)
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_audit_logs WHERE actor = $1`, "audit-tester")
		_, _ = store.pool.Exec(ctx, `DELETE FROM admin_commands WHERE actor = $1`, "audit-tester")
	})

	_, err := srv.createAdminConsoleUser(ctx, operator, password, []string{permissionAdminsManage, permissionAuditRead}, true)
	if err != nil {
		t.Fatalf("create operator: %v", err)
	}

	mk := func(n int) admin.CommandMeta {
		return admin.CommandMeta{
			CommandID: fmt.Sprintf("test-cmd-%s-%d", suffix, n),
			Actor:     "audit-tester",
			Reason:    "integration",
			DryRun:    n%2 == 0,
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/audit-logs", nil)

	// One completed real run and one failed dry run.
	ok := admin.CommandResult{CommandID: mk(1).CommandID, Action: "set-admin-operator-password", Status: "ok", Message: "done"}
	srv.recordAgentCommand(req, mk(1), "set-admin-operator-password", "completed", &ok, nil)
	srv.recordAgentCommand(req, mk(2), "set-admin-operator-access", "failed", nil, errors.New("boom"))

	got, err := store.listAuditLogs(ctx, "", "", "", 10)
	if err != nil {
		t.Fatalf("list audit logs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("list returned %d rows, want 2", len(got))
	}
	// Newest first by id.
	if got[0].Action != "set-admin-operator-access" || got[0].Status != "failed" || got[0].Error != "boom" {
		t.Fatalf("row[0]=%+v", got[0])
	}
	if got[1].DryRun || got[1].Status != "completed" || !strings.Contains(got[1].Result, `"message": "done"`) {
		t.Fatalf("row[1]=%+v (result=%s)", got[1], got[1].Result)
	}

	// The same records surface through the routed HTTP endpoint with filters,
	// for an operator holding audit.read.
	cookies, _ := namedSignIn(t, srv, operator, password)
	filter := func(query string) []auditLogAPIEntry {
		t.Helper()
		rec := httptest.NewRecorder()
		srv.routes().ServeHTTP(rec, withCookies(httptest.NewRequest(http.MethodGet, "/api/audit-logs?"+query, nil), cookies))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/audit-logs?%s status=%d body=%s", query, rec.Code, rec.Body.String())
		}
		var out struct {
			Rows []auditLogAPIEntry `json:"rows"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode audit response: %v", err)
		}
		return out.Rows
	}

	if rows := filter("actor=audit-tester"); len(rows) != 2 {
		t.Fatalf("actor filter rows=%d, want 2", len(rows))
	}
	if rows := filter("status=failed"); len(rows) != 1 || rows[0].Status != "failed" {
		t.Fatalf("status filter rows=%+v", rows)
	}
	if rows := filter("action=set-admin-operator-password"); len(rows) != 1 {
		t.Fatalf("action filter rows=%d, want 1", len(rows))
	}
	// A limit below the row count slices newest-first.
	if rows := filter("limit=1"); len(rows) != 1 || rows[0].Action != "set-admin-operator-access" {
		t.Fatalf("limit filter rows=%+v", rows)
	}
}
