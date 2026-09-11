package audit

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/blake2b"
)

type PolicyHit struct {
	PolicyID    string `json:"policy_id"`
	Severity    string `json:"severity"`
	Action      string `json:"action"`
	MatchedRule string `json:"matched_rule,omitempty"`
}

type Event struct {
	ID                 string          `json:"id"`
	TenantID           string          `json:"tenant_id"`
	EventTime          string          `json:"event_time"`
	EventType          string          `json:"event_type"`
	UserID             string          `json:"user_id,omitempty"`
	UserEmail          string          `json:"user_email,omitempty"`
	DepartmentID       string          `json:"department_id,omitempty"`
	SessionID          string          `json:"session_id,omitempty"`
	TraceID            string          `json:"trace_id,omitempty"`
	ClientType         string          `json:"client_type"`
	ClientIP           string          `json:"client_ip,omitempty"`
	Provider           string          `json:"provider,omitempty"`
	Model              string          `json:"model,omitempty"`
	Route              string          `json:"route"`
	ChannelID          string          `json:"channel_id,omitempty"`
	ChannelKeyRef      string          `json:"channel_key_ref,omitempty"`
	APITokenID         int64           `json:"api_token_id,omitempty"`
	AttemptIndex       int             `json:"attempt_index,omitempty"`
	RetryReason        string          `json:"retry_reason,omitempty"`
	InboundProtocol    string          `json:"inbound_protocol,omitempty"`
	OutboundProtocol   string          `json:"outbound_protocol,omitempty"`
	ReasoningEffort    string          `json:"reasoning_effort,omitempty"`
	ThinkingMode       string          `json:"thinking_mode,omitempty"`
	CacheLayer         string          `json:"cache_layer,omitempty"`
	CacheKeyHash       string          `json:"cache_key_hash,omitempty"`
	SemanticSimilarity float64         `json:"semantic_similarity,omitempty"`
	LatencyMSUpstream  int64           `json:"latency_ms_upstream,omitempty"`
	EstimatedTokens    int             `json:"estimated_tokens,omitempty"`
	ActualTokens       int             `json:"actual_tokens,omitempty"`
	SettleDelta        int64           `json:"settle_delta,omitempty"`
	Attempts           json.RawMessage `json:"attempts,omitempty"`
	InputTokens        int             `json:"input_tokens,omitempty"`
	OutputTokens       int             `json:"output_tokens,omitempty"`
	TotalTokens        int             `json:"total_tokens,omitempty"`
	LatencyMS          int64           `json:"latency_ms,omitempty"`
	Digest             *Digest         `json:"digest,omitempty"`
	ToolsCalled        []string        `json:"tools_called,omitempty"`
	PoliciesHit        []PolicyHit     `json:"policies_hit,omitempty"`
	MCPStatus          string          `json:"mcp_status,omitempty"`
	MCPServer          string          `json:"mcp_server,omitempty"`
	MCPToolName        string          `json:"mcp_tool_name,omitempty"`
	MCPInputHash       string          `json:"mcp_input_hash,omitempty"`
	MCPOutputHash      string          `json:"mcp_output_hash,omitempty"`
	RoutingPolicy      json.RawMessage `json:"routing_policy,omitempty"`
	PluginsInvoked     []string        `json:"plugins_invoked,omitempty"`
	SrcRegion          string          `json:"src_region,omitempty"`
	DstRegion          string          `json:"dst_region,omitempty"`
	CrossBorder        bool            `json:"cross_border,omitempty"`
	ResidencyRule      string          `json:"residency_rule,omitempty"`
	ChecksumVersion    string          `json:"checksum_version,omitempty"`
	PrevChecksum       string          `json:"prev_checksum"`
	Checksum           string          `json:"checksum"`
	ChecksumPayload    string          `json:"-"`
}

type Digest struct {
	PromptHash      string `json:"prompt_hash"`
	ResponseHash    string `json:"response_hash"`
	PromptSummary   string `json:"prompt_summary,omitempty"`
	ResponseSummary string `json:"response_summary,omitempty"`
}

type FileWriter struct {
	dir            string
	currentDate    string
	lastChecksums  map[string]string
	lastEventTimes map[string]time.Time
	recovered      bool
	mu             sync.Mutex
}

const checksumVersionV2 = "v2"

const maxAuditLineBytes = 16 << 20

func NewFileWriter(dir string) *FileWriter {
	return &FileWriter{dir: dir}
}

func (w *FileWriter) Write(event *Event) error {
	if event == nil {
		return os.ErrInvalid
	}
	if strings.TrimSpace(event.TenantID) == "" {
		return os.ErrInvalid
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	if err := os.MkdirAll(w.dir, 0o700); err != nil {
		return err
	}
	date := time.Now().UTC().Format("20060102")
	if w.currentDate != date {
		w.currentDate = date
	}
	filePath := filepath.Join(w.dir, "audit-"+date+".jsonl")
	if !w.recovered {
		var err error
		w.lastChecksums, w.lastEventTimes, err = readTenantLastChecksums(w.dir)
		if err != nil {
			return err
		}
		w.recovered = true
	}

	eventTime, err := normalizeEventTime(event.EventTime, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("audit: invalid event_time for tenant %q: %w", event.TenantID, err)
	}
	if lastEventTime, ok := w.lastEventTimes[event.TenantID]; ok && !eventTime.After(lastEventTime) {
		eventTime = lastEventTime.Add(time.Microsecond)
	}
	event.EventTime = eventTime.Format(time.RFC3339Nano)
	event.PrevChecksum = nonEmpty(w.lastChecksums[event.TenantID], "GENESIS")
	event.ChecksumVersion = checksumVersionV2
	event.Checksum = ""
	rawForChecksum, err := json.Marshal(event)
	if err != nil {
		return err
	}
	sum := blake2b.Sum512([]byte(event.PrevChecksum + "|" + string(rawForChecksum)))
	event.Checksum = hex.EncodeToString(sum[:])[:64]
	event.ChecksumPayload = string(rawForChecksum)
	finalRaw, err := json.Marshal(event)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(finalRaw, '\n')); err != nil {
		return err
	}
	w.lastChecksums[event.TenantID] = event.Checksum
	w.lastEventTimes[event.TenantID] = eventTime
	return nil
}

func readLastChecksum(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var line string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line = scanner.Text()
	}
	if strings.TrimSpace(line) == "" {
		return ""
	}
	var event Event
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		return ""
	}
	return event.Checksum
}

func readGlobalLastChecksum(dir string) string {
	files, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	lastFile := ""
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		name := file.Name()
		if !strings.HasPrefix(name, "audit-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		if name > lastFile {
			lastFile = name
		}
	}
	if lastFile == "" {
		return ""
	}
	return readLastChecksum(filepath.Join(dir, lastFile))
}

// readTenantLastChecksums recovers the last checksum and maximum event time
// for each tenant from all audit JSONL files. Files are ordered by date (their
// names are the canonical audit date), and lines are processed in file order
// so each tenant's checksum cursor reflects the last event written for that
// tenant, independent of other tenants interleaved in the same file.
func readTenantLastChecksums(dir string) (map[string]string, map[string]time.Time, error) {
	checksums := make(map[string]string)
	eventTimes := make(map[string]time.Time)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, fmt.Errorf("audit checksum recovery: read directory %q: %w", dir, err)
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, "audit-") && strings.HasSuffix(name, ".jsonl") {
			files = append(files, name)
		}
	}
	sort.Strings(files)

	for _, name := range files {
		path := filepath.Join(dir, name)
		f, err := os.Open(path)
		if err != nil {
			return nil, nil, fmt.Errorf("audit checksum recovery: open %q: %w", path, err)
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, maxAuditLineBytes), maxAuditLineBytes)
		lineNumber := 0
		for scanner.Scan() {
			lineNumber++
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var event Event
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				_ = f.Close()
				return nil, nil, fmt.Errorf("audit checksum recovery: decode %q line %d: %w", path, lineNumber, err)
			}
			if strings.TrimSpace(event.TenantID) == "" {
				_ = f.Close()
				return nil, nil, fmt.Errorf("audit checksum recovery: empty tenant_id in %q line %d", path, lineNumber)
			}
			if strings.TrimSpace(event.Checksum) == "" {
				_ = f.Close()
				return nil, nil, fmt.Errorf("audit checksum recovery: empty checksum for tenant %q in %q line %d", event.TenantID, path, lineNumber)
			}
			eventTime, err := parseEventTime(event.EventTime)
			if err != nil {
				_ = f.Close()
				return nil, nil, fmt.Errorf("audit checksum recovery: invalid event_time for tenant %q in %q line %d: %w", event.TenantID, path, lineNumber, err)
			}
			checksums[event.TenantID] = event.Checksum
			eventTime = eventTime.Truncate(time.Microsecond)
			if lastEventTime, ok := eventTimes[event.TenantID]; !ok || eventTime.After(lastEventTime) {
				eventTimes[event.TenantID] = eventTime
			}
		}
		if err := scanner.Err(); err != nil {
			_ = f.Close()
			return nil, nil, fmt.Errorf("audit checksum recovery: scan %q: %w", path, err)
		}
		if err := f.Close(); err != nil {
			return nil, nil, fmt.Errorf("audit checksum recovery: close %q: %w", path, err)
		}
	}

	return checksums, eventTimes, nil
}

func normalizeEventTime(value string, fallback time.Time) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return fallback.UTC().Truncate(time.Microsecond), nil
	}
	parsed, err := parseEventTime(value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.Truncate(time.Microsecond), nil
}

func parseEventTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, fmt.Errorf("empty value")
	}
	return time.Parse(time.RFC3339Nano, value)
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
