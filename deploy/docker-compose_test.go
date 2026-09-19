package deploy_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"telesrv/internal/config"
	"telesrv/internal/store/redisstore"
)

func TestLegacyComposeConfigMatrix(t *testing.T) {
	requireCompose(t, false)
	clearDeploymentEnvironment(t)
	root := repositoryRoot(t)
	example, err := os.ReadFile(filepath.Join(root, ".env.example"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, env, postgres, redis string
		overrides                  map[string]string
	}{
		{name: "no env", postgres: "telesrv"},
		{name: "example", env: string(example), postgres: "telesrv"},
		{name: "existing empty passwords", env: "TELESRV_POSTGRES_PASSWORD=\nTELESRV_REDIS_PASSWORD=\n", postgres: "telesrv"},
		{name: "custom passwords", env: "TELESRV_POSTGRES_PASSWORD=pg-custom\nTELESRV_REDIS_PASSWORD=redis-custom\n", postgres: "pg-custom", redis: "redis-custom"},
		{name: "process overrides", env: "TELESRV_POSTGRES_PASSWORD=from-file\nTELESRV_REDIS_PASSWORD=from-file\n", postgres: "from-process", redis: "from-process", overrides: map[string]string{"TELESRV_POSTGRES_PASSWORD": "from-process", "TELESRV_REDIS_PASSWORD": "from-process"}},
		{name: "empty process overrides", env: "TELESRV_POSTGRES_PASSWORD=from-file\nTELESRV_REDIS_PASSWORD=from-file\n", postgres: "telesrv", overrides: map[string]string{"TELESRV_POSTGRES_PASSWORD": "", "TELESRV_REDIS_PASSWORD": ""}},
		{name: "reserved characters", env: "TELESRV_POSTGRES_PASSWORD='p@ss:word/with?reserved#chars$literal'\nTELESRV_REDIS_PASSWORD='redis @:#/ $literal'\n", postgres: "p@ss:word/with?reserved#chars$literal", redis: "redis @:#/ $literal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.overrides {
				t.Setenv(key, value)
			}
			envFile := filepath.Join(t.TempDir(), ".env")
			writeComposeFile(t, envFile, tc.env)
			output := dockerCommand(t, nil, "compose", "--env-file", envFile, "-f", filepath.Join(root, "deploy", "docker-compose.yml"), "config", "--format", "json")
			var model struct {
				Services map[string]struct{ Environment map[string]string }
			}
			if err := json.Unmarshal(output, &model); err != nil {
				t.Fatal(err)
			}
			cfg := loadComposeConfig(t, envFile)
			pg, err := pgx.ParseConfig(cfg.PostgresDSN)
			if err != nil {
				t.Fatal(err)
			}
			// Compose escapes literal dollars for round-tripping its rendered
			// configuration. Live authentication below verifies the real value.
			if got := strings.ReplaceAll(model.Services["postgres"].Environment["POSTGRES_PASSWORD"], "$$", "$"); got != tc.postgres || got != pg.Password {
				t.Fatal("Postgres container, server DSN and expected password differ")
			}
			if pg.User != "telesrv" || pg.Database != "telesrv_main" || pg.Host != "127.0.0.1" || pg.Port != 5432 {
				t.Fatal("derived DSN no longer targets the main development database")
			}
			if got := strings.ReplaceAll(model.Services["redis"].Environment["REDIS_PASSWORD"], "$$", "$"); got != tc.redis || got != cfg.RedisPassword {
				t.Fatal("Redis container, server and expected password differ")
			}
		})
	}
}

func TestLegacyComposeCredentialsIntegration(t *testing.T) {
	if os.Getenv("TELESRV_RUN_COMPOSE_INTEGRATION") != "1" {
		t.Skip("set TELESRV_RUN_COMPOSE_INTEGRATION=1 for the isolated volume upgrade test")
	}
	requireCompose(t, true)
	clearDeploymentEnvironment(t)
	root := repositoryRoot(t)
	project := "gramsrv-credentials-" + strings.ToLower(rand.Text()[:12])
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env")
	override := filepath.Join(dir, "compose.test.yaml")
	writeComposeFile(t, envFile, "")
	// Only names, published ports and authentication policy are overridden.
	// Exercise the real commands, healthchecks, init scripts and named volumes
	// without touching a developer's stack.
	writeComposeFile(t, override, fmt.Sprintf(`services:
  postgres:
    container_name: %s-postgres
    environment:
      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256 --auth-local=trust
    ports: !override ["127.0.0.1::5432"]
  redis:
    container_name: %s-redis
    ports: !override ["127.0.0.1::6379"]
`, project, project))
	compose := []string{"compose", "-p", project, "--env-file", envFile, "-f", filepath.Join(root, "deploy", "docker-compose.yml"), "-f", override}
	run := func(stdin *strings.Reader, args ...string) []byte {
		return dockerCommand(t, stdin, append(append([]string{}, compose...), args...)...)
	}
	t.Cleanup(func() { run(nil, "down", "--volumes", "--remove-orphans") })
	start := func() (string, string) {
		run(nil, "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60")
		return strings.TrimSpace(string(run(nil, "port", "postgres", "5432"))), strings.TrimSpace(string(run(nil, "port", "redis", "6379")))
	}

	pgAddr, redisAddr := start()
	cfg := loadComposeConfig(t, envFile)
	pg := connectComposePostgres(t, cfg.PostgresDSN, pgAddr)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := pg.Exec(ctx, "CREATE TABLE credential_rotation_probe (value text PRIMARY KEY); INSERT INTO credential_rotation_probe VALUES ('retained')")
	cancel()
	pg.Close(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	checkComposeRedis(t, cfg, redisAddr)

	// Old .env files explicitly set an empty Redis password. A restart must
	// preserve connectivity and the existing PostgreSQL volume.
	writeComposeFile(t, envFile, "TELESRV_REDIS_PASSWORD=\n")
	pgAddr, redisAddr = start()
	cfg = loadComposeConfig(t, envFile)
	checkComposeRedis(t, cfg, redisAddr)
	checkComposeMarker(t, cfg.PostgresDSN, pgAddr)
	oldDSN := cfg.PostgresDSN

	const newPGPassword = "new@pg:/?password#$literal"
	writeComposeFile(t, envFile, "TELESRV_POSTGRES_PASSWORD='"+newPGPassword+"'\nTELESRV_REDIS_PASSWORD='new redis@:# $literal'\n")
	pgAddr, redisAddr = start()
	cfg = loadComposeConfig(t, envFile)
	checkComposeRedis(t, cfg, redisAddr)
	// Changing container environment alone does not rotate the persisted role.
	checkComposeMarker(t, oldDSN, pgAddr)
	requirePostgresAuthFailure(t, cfg.PostgresDSN, pgAddr)

	// Exercise the documented psql \password command. Without a TTY, psql
	// reads its two password prompts from stdin. No password enters SQL or argv.
	run(strings.NewReader(newPGPassword+"\n"+newPGPassword+"\n"), "exec", "-T", "postgres", "psql", "-U", "telesrv", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "\\password telesrv")
	checkComposeMarker(t, cfg.PostgresDSN, pgAddr)
	requirePostgresAuthFailure(t, oldDSN, pgAddr)

	pgAddr, redisAddr = start()
	checkComposeMarker(t, cfg.PostgresDSN, pgAddr)
	requirePostgresAuthFailure(t, oldDSN, pgAddr)
	checkComposeRedis(t, cfg, redisAddr)
}

func checkComposeRedis(t *testing.T, cfg config.Config, addr string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := redisstore.Open(ctx, addr, cfg.RedisPassword, cfg.RedisDB)
	if err != nil {
		t.Fatalf("server Redis credentials: %v", err)
	}
	client.Close()
	if cfg.RedisPassword != "" {
		client, err := redisstore.Open(ctx, addr, "incorrect-password", cfg.RedisDB)
		if err == nil {
			client.Close()
			t.Fatal("Redis accepted an incorrect password")
		}
		if !strings.Contains(err.Error(), "WRONGPASS") {
			t.Fatalf("expected Redis authentication rejection, got: %v", err)
		}
	}
}

func composePostgresConfig(t *testing.T, dsn, addr string) *pgx.ConnConfig {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Host, cfg.Port = host, uint16(parsed)
	return cfg
}

func connectComposePostgres(t *testing.T, dsn, addr string) *pgx.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, composePostgresConfig(t, dsn, addr))
	if err != nil {
		t.Fatalf("server Postgres credentials: %v", err)
	}
	return conn
}

func checkComposeMarker(t *testing.T, dsn, addr string) {
	t.Helper()
	conn := connectComposePostgres(t, dsn, addr)
	defer conn.Close(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var value string
	if err := conn.QueryRow(ctx, "SELECT value FROM credential_rotation_probe").Scan(&value); err != nil || value != "retained" {
		t.Fatalf("existing volume marker: value=%q err=%v", value, err)
	}
}

func requirePostgresAuthFailure(t *testing.T, dsn, addr string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, composePostgresConfig(t, dsn, addr))
	if err == nil {
		conn.Close(context.Background())
		t.Fatal("Postgres accepted an incorrect password")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "28P01" {
		t.Fatalf("expected Postgres authentication rejection, got: %v", err)
	}
}

func loadComposeConfig(t *testing.T, envFile string) config.Config {
	t.Helper()
	t.Setenv("TELESRV_CONFIG", envFile)
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func clearDeploymentEnvironment(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "TELESRV_") || strings.HasPrefix(key, "COMPOSE_") || strings.HasPrefix(key, "PG") {
			// Setenv registers restoration; unset then lets the supplied file
			// win instead of an inherited shell variable (even an empty one).
			t.Setenv(key, "")
			if err := os.Unsetenv(key); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func requireCompose(t *testing.T, integration bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "docker", "compose", "version").Run(); err != nil {
		if integration {
			t.Fatalf("Docker Compose is required for integration tests: %v", err)
		}
		t.Skip("Docker Compose is not installed")
	}
}

func dockerCommand(t *testing.T, stdin *strings.Reader, args ...string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Dir = repositoryRoot(t)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return output
}

func writeComposeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(filename), ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}
