package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// serverDockerStatus is the Services tab's view of this deployment's Compose
// containers. It is deliberately best-effort: the admin console ships in a
// hardened container (read-only rootfs, no Docker socket), so "don't ask
// Docker" is a normal state, reported as available:false with a reason rather
// than failing the whole status endpoint.
type serverDockerStatus struct {
	Available bool            `json:"available"`
	Error     string          `json:"error,omitempty"`
	Compose   string          `json:"compose,omitempty"`
	Services  []dockerService `json:"services"`
}

// dockerService is one container's live state, as reported by
// `docker compose ps`. State is Docker's raw container state ("running",
// "exited", ...); Health is the healthcheck status ("healthy", "starting",
// "unhealthy") or "" when no healthcheck is defined.
type dockerService struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Health string `json:"health"`
}

// dockerComposePSRow mirrors the fields `docker compose ps --all --format json`
// emits (Compose v2's ndjson convention: one object per line, not an array).
type dockerComposePSRow struct {
	Service string `json:"Service"`
	State   string `json:"State"`
	Health  string `json:"Health"`
}

// dockerComposeCandidates are checked in order against the repo root. The
// dev-dependency file wins (it is the one that actually holds Postgres and
// Redis for this checkout); the production compose is the fallback.
var dockerComposeCandidates = []string{
	filepath.Join("deploy", "docker-compose.yml"),
	filepath.Join("deploy", "docker", "compose.yaml"),
}

func dockerComposeFile(root string) string {
	if override := strings.TrimSpace(os.Getenv("TELESRV_ADMIN_COMPOSE_FILE")); override != "" {
		if _, err := os.Stat(override); err == nil {
			return override
		}
	}
	for _, candidate := range dockerComposeCandidates {
		path := filepath.Join(root, candidate)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

// dockerStatusBestEffort asks Docker for the Compose services and never turns
// a missing CLI/daemon/compose file into an error. The reason is surfaced so
// the panel can explain why the container list is empty.
func dockerStatusBestEffort(ctx context.Context, root string) serverDockerStatus {
	composeFile := dockerComposeFile(root)
	if composeFile == "" {
		return serverDockerStatus{Error: "compose file not found", Services: []dockerService{}}
	}
	cmd := exec.CommandContext(ctx, "docker", "compose", "-f", composeFile, "ps", "--all", "--format", "json")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return serverDockerStatus{Error: err.Error(), Compose: composeFile, Services: []dockerService{}}
	}
	return serverDockerStatus{Available: true, Compose: composeFile, Services: parseDockerComposePS(out)}
}

// parseDockerComposePS accepts both ndjson (current Compose v2) and the older
// single-array output, and silently skips lines that aren't JSON objects.
func parseDockerComposePS(out []byte) []dockerService {
	trimmed := strings.TrimSpace(string(out))
	services := make([]dockerService, 0)
	if trimmed == "" {
		return services
	}
	if strings.HasPrefix(trimmed, "[") {
		var rows []dockerComposePSRow
		if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
			return services
		}
		return dockerServicesFromRows(rows)
	}
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row dockerComposePSRow
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		services = append(services, dockerService{Name: row.Service, State: row.State, Health: row.Health})
	}
	return services
}

func dockerServicesFromRows(rows []dockerComposePSRow) []dockerService {
	services := make([]dockerService, 0, len(rows))
	for _, row := range rows {
		services = append(services, dockerService{Name: row.Service, State: row.State, Health: row.Health})
	}
	return services
}
