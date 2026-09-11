package audit

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestFileWriter_ChecksumChainIsIndependentPerTenant(t *testing.T) {
	dir := t.TempDir()
	w := NewFileWriter(dir)

	events := []*Event{
		{ID: "a1", TenantID: "tenant-a", EventType: "a1"},
		{ID: "b1", TenantID: "tenant-b", EventType: "b1"},
		{ID: "a2", TenantID: "tenant-a", EventType: "a2"},
		{ID: "b2", TenantID: "tenant-b", EventType: "b2"},
	}
	for _, event := range events {
		if err := w.Write(event); err != nil {
			t.Fatalf("write %s: %v", event.ID, err)
		}
	}

	if got := events[0].PrevChecksum; got != "GENESIS" {
		t.Fatalf("tenant A first prev checksum = %q, want GENESIS", got)
	}
	if got := events[1].PrevChecksum; got != "GENESIS" {
		t.Fatalf("tenant B first prev checksum = %q, want GENESIS", got)
	}
	if got, want := events[2].PrevChecksum, events[0].Checksum; got != want {
		t.Fatalf("tenant A second prev checksum = %q, want %q", got, want)
	}
	if got, want := events[3].PrevChecksum, events[1].Checksum; got != want {
		t.Fatalf("tenant B second prev checksum = %q, want %q", got, want)
	}
}

func TestFileWriter_RestartRecoversChecksumCursorPerTenant(t *testing.T) {
	dir := t.TempDir()
	w := NewFileWriter(dir)

	a1 := &Event{ID: "a1", TenantID: "tenant-a", EventType: "a1"}
	b1 := &Event{ID: "b1", TenantID: "tenant-b", EventType: "b1"}
	for _, event := range []*Event{a1, b1} {
		if err := w.Write(event); err != nil {
			t.Fatalf("initial write %s: %v", event.ID, err)
		}
	}

	restarted := NewFileWriter(dir)
	a2 := &Event{ID: "a2", TenantID: "tenant-a", EventType: "a2"}
	b2 := &Event{ID: "b2", TenantID: "tenant-b", EventType: "b2"}
	for _, event := range []*Event{a2, b2} {
		if err := restarted.Write(event); err != nil {
			t.Fatalf("restart write %s: %v", event.ID, err)
		}
	}

	if got, want := a2.PrevChecksum, a1.Checksum; got != want {
		t.Fatalf("tenant A recovered prev checksum = %q, want %q", got, want)
	}
	if got, want := b2.PrevChecksum, b1.Checksum; got != want {
		t.Fatalf("tenant B recovered prev checksum = %q, want %q", got, want)
	}
}

func TestReadTenantLastChecksums_ScansFilesInDateOrder(t *testing.T) {
	dir := t.TempDir()
	w := NewFileWriter(dir)
	oldEvent := &Event{ID: "old", TenantID: "tenant-a", EventType: "old"}
	newEvent := &Event{ID: "new", TenantID: "tenant-a", EventType: "new"}
	if err := w.Write(oldEvent); err != nil {
		t.Fatalf("write old event: %v", err)
	}
	if err := w.Write(newEvent); err != nil {
		t.Fatalf("write new event: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read audit directory: %v", err)
	}
	var currentFile string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "audit-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			currentFile = filepath.Join(dir, entry.Name())
			break
		}
	}
	if currentFile == "" {
		t.Fatal("audit file not found")
	}
	contents, err := os.ReadFile(currentFile)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(contents)), "\n")
	if len(lines) != 2 {
		t.Fatalf("initial audit line count = %d, want 2", len(lines))
	}
	oldPath := filepath.Join(dir, "audit-20000101.jsonl")
	if err := os.WriteFile(oldPath, []byte(lines[0]+"\n"), 0o600); err != nil {
		t.Fatalf("write old audit file: %v", err)
	}
	if err := os.WriteFile(currentFile, []byte(lines[1]+"\n"), 0o600); err != nil {
		t.Fatalf("rewrite current audit file: %v", err)
	}

	// The newer file contains the later event, so a restarted writer must use
	// the latest event for the tenant across files rather than the last line of
	// one file.
	restarted := NewFileWriter(dir)
	latest := &Event{ID: "latest", TenantID: "tenant-a", EventType: "latest"}
	if err := restarted.Write(latest); err != nil {
		t.Fatalf("restart write latest event: %v", err)
	}
	if got, want := latest.PrevChecksum, newEvent.Checksum; got != want {
		t.Fatalf("recovered tenant checksum = %q, want %q", got, want)
	}

	// Keep the JSONL fixture valid and ensure the test exercises actual lines,
	// not only the in-memory cursor.
	f, err := os.Open(oldPath)
	if err != nil {
		t.Fatalf("open old audit file: %v", err)
	}
	scanner := bufio.NewScanner(f)
	lineCount := 0
	for scanner.Scan() {
		var event Event
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("decode recovered line: %v", err)
		}
		lineCount++
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close old audit file: %v", err)
	}
	if lineCount != 1 {
		t.Fatalf("old-file line count = %d, want 1", lineCount)
	}
}

func TestFileWriter_RestartRecoversAuditLineLargerThanScannerDefault(t *testing.T) {
	dir := t.TempDir()
	w := NewFileWriter(dir)
	first := &Event{
		ID:        "large",
		TenantID:  "tenant-large",
		EventType: "large_payload",
		Digest: &Digest{
			PromptHash:      "prompt",
			ResponseHash:    "response",
			ResponseSummary: strings.Repeat("x", 70<<10),
		},
	}
	if err := w.Write(first); err != nil {
		t.Fatalf("write large event: %v", err)
	}

	restarted := NewFileWriter(dir)
	next := &Event{ID: "next", TenantID: "tenant-large", EventType: "next"}
	if err := restarted.Write(next); err != nil {
		t.Fatalf("recover after large event: %v", err)
	}
	if got, want := next.PrevChecksum, first.Checksum; got != want {
		t.Fatalf("recovered checksum = %q, want %q", got, want)
	}
}

func TestFileWriter_NormalizesEventTimeAndKeepsChecksumOrderAfterRestart(t *testing.T) {
	dir := t.TempDir()
	w := NewFileWriter(dir)
	first := &Event{
		ID:        "z-first",
		TenantID:  "tenant-time",
		EventTime: "2026-08-29T10:00:00Z",
		EventType: "first",
	}
	earlier := &Event{
		ID:        "a-earlier",
		TenantID:  "tenant-time",
		EventTime: "2026-08-29T09:00:00.9999999Z",
		EventType: "earlier",
	}
	same := &Event{
		ID:        "m-same",
		TenantID:  "tenant-time",
		EventTime: "2026-08-29T10:00:00Z",
		EventType: "same",
	}
	for _, event := range []*Event{first, earlier, same} {
		if err := w.Write(event); err != nil {
			t.Fatalf("write %s: %v", event.ID, err)
		}
	}

	if first.EventTime != "2026-08-29T10:00:00Z" {
		t.Fatalf("first explicit event_time changed to %q", first.EventTime)
	}
	if earlier.EventTime != "2026-08-29T10:00:00.000001Z" {
		t.Fatalf("earlier event_time = %q, want one microsecond after first", earlier.EventTime)
	}
	if same.EventTime != "2026-08-29T10:00:00.000002Z" {
		t.Fatalf("same event_time = %q, want one microsecond after earlier", same.EventTime)
	}
	if got, want := earlier.PrevChecksum, first.Checksum; got != want {
		t.Fatalf("earlier prev checksum = %q, want %q", got, want)
	}
	if got, want := same.PrevChecksum, earlier.Checksum; got != want {
		t.Fatalf("same prev checksum = %q, want %q", got, want)
	}

	restarted := NewFileWriter(dir)
	afterRestart := &Event{
		ID:        "b-restart",
		TenantID:  "tenant-time",
		EventTime: "2026-08-29T08:00:00Z",
		EventType: "restart",
	}
	if err := restarted.Write(afterRestart); err != nil {
		t.Fatalf("restart write: %v", err)
	}
	if afterRestart.EventTime != "2026-08-29T10:00:00.000003Z" {
		t.Fatalf("restart event_time = %q, want one microsecond after recovered cursor", afterRestart.EventTime)
	}
	if got, want := afterRestart.PrevChecksum, same.Checksum; got != want {
		t.Fatalf("restart prev checksum = %q, want %q", got, want)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read audit directory: %v", err)
	}
	var path string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "audit-") && strings.HasSuffix(entry.Name(), ".jsonl") {
			path = filepath.Join(dir, entry.Name())
			break
		}
	}
	if path == "" {
		t.Fatal("audit file not found")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(contents)), "\n")
	if len(lines) != 4 {
		t.Fatalf("persisted event count = %d, want 4", len(lines))
	}
	persisted := make([]Event, 0, len(lines))
	for _, line := range lines {
		var event Event
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode persisted event: %v", err)
		}
		persisted = append(persisted, event)
	}
	sorted := append([]Event(nil), persisted...)
	sort.Slice(sorted, func(i, j int) bool {
		left, _ := time.Parse(time.RFC3339Nano, sorted[i].EventTime)
		right, _ := time.Parse(time.RFC3339Nano, sorted[j].EventTime)
		if left.Equal(right) {
			return sorted[i].ID < sorted[j].ID
		}
		return left.Before(right)
	})
	for i := range persisted {
		if persisted[i].ID != sorted[i].ID {
			t.Fatalf("checksum order differs from event_time,id order at %d: persisted=%q sorted=%q", i, persisted[i].ID, sorted[i].ID)
		}
		if i == 0 {
			if persisted[i].PrevChecksum != "GENESIS" {
				t.Fatalf("first persisted prev checksum = %q, want GENESIS", persisted[i].PrevChecksum)
			}
			continue
		}
		if persisted[i].PrevChecksum != persisted[i-1].Checksum {
			t.Fatalf("persisted checksum order broken at %d: prev=%q prior=%q", i, persisted[i].PrevChecksum, persisted[i-1].Checksum)
		}
		previous, _ := time.Parse(time.RFC3339Nano, persisted[i-1].EventTime)
		current, _ := time.Parse(time.RFC3339Nano, persisted[i].EventTime)
		if !current.After(previous) {
			t.Fatalf("event_time not strictly increasing at %d: %q then %q", i, persisted[i-1].EventTime, persisted[i].EventTime)
		}
	}
}

func TestFileWriter_RejectsEmptyTenantID(t *testing.T) {
	w := NewFileWriter(t.TempDir())
	if err := w.Write(&Event{ID: "missing-tenant"}); err != os.ErrInvalid {
		t.Fatalf("empty tenant error = %v, want %v", err, os.ErrInvalid)
	}
}

func TestFileWriter_RejectsDamagedOrEmptyChecksumCursor(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{name: "damaged json", line: "{not-json}\n"},
		{name: "empty tenant", line: `{"tenant_id":"","event_time":"2026-08-29T00:00:00Z","checksum":"checksum"}` + "\n"},
		{name: "empty checksum", line: `{"tenant_id":"tenant-a","event_time":"2026-08-29T00:00:00Z","checksum":""}` + "\n"},
		{name: "invalid event time", line: `{"tenant_id":"tenant-a","event_time":"not-a-time","checksum":"checksum"}` + "\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "audit-20260829.jsonl")
			if err := os.WriteFile(path, []byte(tt.line), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			w := NewFileWriter(dir)
			err := w.Write(&Event{ID: "new", TenantID: "tenant-a", EventType: "new"})
			if err == nil {
				t.Fatal("write unexpectedly succeeded with damaged checksum cursor")
			}
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatalf("read audit directory: %v", readErr)
			}
			if len(entries) != 1 || entries[0].Name() != "audit-20260829.jsonl" {
				t.Fatalf("unexpected files after rejected write: %v", entries)
			}
		})
	}
}
