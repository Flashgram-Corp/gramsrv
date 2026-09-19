package procctl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testTemplate = `## Server -- Telegram-compatible MTProto server settings
# Product name shown to the clients
TELESRV_PRODUCT_NAME=telesrv
# Admin login password
TELESRV_ADMIN_UI_PASSWORD=changeme
# Secret-chat files retention (not a credential)
TELESRV_SECRET_CHAT_DELETE_FILE_AFTER_DOWNLOAD=true

## Optional -- commented-out optional fields
# API token for integrations
# TELESRV_API_TOKEN=
# Debug logs (off by default)
# TELESRV_DEBUG_LOGS=false

# ============ end ============
`

func writeRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env.example"), []byte(testTemplate), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestReadEnvGroupsNeverParsesPlaceholders(t *testing.T) {
	m := NewManager(writeRepo(t))
	groups, err := m.ReadEnvGroups()
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	server := groups[0]
	if server.Title != "Server" || server.Description != "Telegram-compatible MTProto server settings" {
		t.Fatalf("server group = %+v", server)
	}
	if len(server.Fields) != 3 {
		t.Fatalf("server fields = %d, want 3", len(server.Fields))
	}
	if f := server.Fields[0]; f.Key != "TELESRV_PRODUCT_NAME" || f.Value != "telesrv" || !f.EnabledByDefault || f.Sensitive {
		t.Fatalf("product field = %+v", f)
	}
	if f := server.Fields[1]; f.Key != "TELESRV_ADMIN_UI_PASSWORD" || f.Value != "changeme" || !f.Sensitive {
		t.Fatalf("password field = %+v", f)
	}
	if f := server.Fields[2]; f.Key != "TELESRV_SECRET_CHAT_DELETE_FILE_AFTER_DOWNLOAD" || f.Sensitive {
		t.Fatalf("secret-chat field must not be sensitive: %+v", f)
	}
	opt := groups[1]
	if len(opt.Fields) != 2 {
		t.Fatalf("optional fields = %d, want 2", len(opt.Fields))
	}
	if f := opt.Fields[0]; f.Key != "TELESRV_API_TOKEN" || f.EnabledByDefault || !f.Sensitive || f.Value != "" {
		t.Fatalf("api token field = %+v", f)
	}
	if f := opt.Fields[1]; f.Key != "TELESRV_DEBUG_LOGS" || f.EnabledByDefault || f.Value != "" {
		t.Fatalf("debug logs field = %+v", f)
	}
}

func TestReadEnvGroupsFillsValuesFromEnv(t *testing.T) {
	dir := writeRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELESRV_PRODUCT_NAME=my-server\nTELESRV_ADMIN_UI_PASSWORD=secretpw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(dir)
	groups, err := m.ReadEnvGroups()
	if err != nil {
		t.Fatal(err)
	}
	if v := groups[0].Fields[0].Value; v != "my-server" {
		t.Fatalf(".env value not picked up: %q", v)
	}
	if v := groups[0].Fields[1].Value; v != "secretpw" {
		t.Fatalf("password value not picked up: %q", v)
	}

	// Optional field enabled in .env shows its .env value.
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELESRV_API_TOKEN=abc123\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	groups, err = m.ReadEnvGroups()
	if err != nil {
		t.Fatal(err)
	}
	if v := groups[1].Fields[0].Value; v != "abc123" {
		t.Fatalf("optional enabled value = %q, want abc123", v)
	}
}

func TestWriteEnvValuesRewritesInPlacePreservingLayout(t *testing.T) {
	dir := writeRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELESRV_ADMIN_UI_PASSWORD=existingpw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(dir)
	if err := m.WriteEnvValues(map[string]string{"TELESRV_PRODUCT_NAME": "renamed"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	// Header/comment layout preserved verbatim.
	if !strings.Contains(got, "## Server -- Telegram-compatible MTProto server settings") ||
		!strings.Contains(got, "# Product name shown to the clients") {
		t.Fatalf("layout not preserved:\n%s", got)
	}
	// Only the touched key rewrote; the untouched password kept its .env value.
	if !strings.Contains(got, "TELESRV_PRODUCT_NAME=renamed") {
		t.Fatalf("touched key not updated:\n%s", got)
	}
	if !strings.Contains(got, "TELESRV_ADMIN_UI_PASSWORD=existingpw") {
		t.Fatalf("untouched existing value was not preserved:\n%s", got)
	}
}

func TestWriteEnvValuesUncommentsOptionalField(t *testing.T) {
	dir := writeRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELESRV_ADMIN_UI_PASSWORD=existingpw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(dir)
	if err := m.WriteEnvValues(map[string]string{"TELESRV_API_TOKEN": "tok-123", "TELESRV_DEBUG_LOGS": ""}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "TELESRV_API_TOKEN=tok-123") {
		t.Fatalf("optional field not uncommented+set:\n%s", got)
	}
	// Empty value keeps the commented-out template line.
	if !strings.Contains(got, "# TELESRV_DEBUG_LOGS=false") {
		t.Fatalf("empty optional field should stay commented:\n%s", got)
	}
}

func TestWriteEnvValuesClearsOptionalFieldBackToCommented(t *testing.T) {
	dir := writeRepo(t)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELESRV_API_TOKEN=tok-123\nTELESRV_ADMIN_UI_PASSWORD=existingpw\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(dir)
	if err := m.WriteEnvValues(map[string]string{"TELESRV_API_TOKEN": ""}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	// Clearing an active optional field falls back to the template's commented line.
	if strings.Contains(got, "TELESRV_API_TOKEN=tok-123") || !strings.Contains(got, "# TELESRV_API_TOKEN=") {
		t.Fatalf("cleared optional field should revert to commented template line:\n%s", got)
	}
}

func TestReadEnvGroupsMissingTemplateReturnsEmpty(t *testing.T) {
	m := NewManager(t.TempDir())
	groups, err := m.ReadEnvGroups()
	if err != nil || len(groups) != 0 {
		t.Fatalf("groups=%d err=%v", len(groups), err)
	}
}

// TestRepoEnvExampleGroups ensure the shipped .env.example keeps staying a
// valid template the panel can actually edit: every key must end up inside a
// `##` group (fields that fall between a section break and the next header —
// or before the first header — are orphaned and silently dropped from the
// panel), and no header may be a lone `## line` the regex refuses.
func TestRepoEnvExampleGroups(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, ".env.example"))
	if err != nil {
		t.Fatal(err)
	}
	var templateKeys []string
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if a := activeFieldRe.FindStringSubmatch(line); a != nil {
			templateKeys = append(templateKeys, a[1])
			continue
		}
		if c := commentedFieldRe.FindStringSubmatch(line); c != nil {
			templateKeys = append(templateKeys, c[1])
			continue
		}
	}

	m := NewManager(repoRoot)
	groups, err := m.ReadEnvGroups()
	if err != nil {
		t.Fatal(err)
	}
	covered := map[string]bool{}
	for _, g := range groups {
		for _, f := range g.Fields {
			covered[f.Key] = true
		}
	}
	var missing []string
	for _, key := range templateKeys {
		if !covered[key] {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("keys outside any `##` group would be invisible to the panel: %v", missing)
	}
}

func TestSensitiveDetection(t *testing.T) {
	cases := map[string]bool{
		"TELESRV_ADMIN_UI_PASSWORD":                      true,
		"TELESRV_SECRET_KEY":                             true,
		"TELESRV_API_TOKEN":                              true,
		"TELESRV_REDIS_PASSWORD":                         true,
		"TELESRV_SECRET_CHAT_DELETE_FILE_AFTER_DOWNLOAD": false,
		"TELESRV_PRODUCT_NAME":                           false,
	}
	for key, want := range cases {
		got := sensitiveKeyRe.MatchString(key) && !sensitiveKeyExceptRe.MatchString(key)
		if got != want {
			t.Fatalf("sensitive(%q) = %v, want %v", key, got, want)
		}
	}
}
