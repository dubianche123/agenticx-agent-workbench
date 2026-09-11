package server

import (
	"path/filepath"
	"testing"
)

func TestCacheConfigPathUsesIsolatedAdminRuntimeDir(t *testing.T) {
	t.Setenv("GATEWAY_CACHE_CONFIG_FILE", "")
	t.Setenv("ENTERPRISE_ADMIN_RUNTIME_DIR", filepath.Join(t.TempDir(), "ontology-admin"))

	want := filepath.Join("ontology-admin", "cache-config.json")
	if got := cacheConfigPath(); filepath.Base(got) != filepath.Base(want) || filepath.Base(filepath.Dir(got)) != filepath.Base(filepath.Dir(want)) {
		t.Fatalf("cacheConfigPath() = %q, want runtime-dir cache-config.json", got)
	}
}

func TestCacheConfigPathKeepsExplicitFileOverride(t *testing.T) {
	t.Setenv("GATEWAY_CACHE_CONFIG_FILE", "/tmp/explicit-cache-config.json")
	t.Setenv("ENTERPRISE_ADMIN_RUNTIME_DIR", "/tmp/ignored-runtime")

	if got := cacheConfigPath(); got != "/tmp/explicit-cache-config.json" {
		t.Fatalf("cacheConfigPath() = %q, want explicit override", got)
	}
}
