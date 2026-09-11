package server

import (
	"strings"

	"github.com/agenticx/enterprise/gateway/internal/openai"
)

const (
	modelFinishReasonMetadataKey      = "model_finish_reason"
	modelFinishReasonClassMetadataKey = "model_finish_reason_class"
)

// streamFinishReason remembers the latest terminal reason emitted by the
// primary (index 0) streamed choice. Providers normally emit one terminal
// chunk, but keeping the fallback lets us still observe non-zero choices from
// compatible upstreams that omit index 0.
type streamFinishReason struct {
	primary string
	last    string
}

func (r *streamFinishReason) observe(chunk openai.StreamChunk) {
	if r == nil {
		return
	}
	for _, choice := range chunk.Choices {
		if choice.FinishReason == nil {
			continue
		}
		reason := strings.TrimSpace(*choice.FinishReason)
		if reason == "" {
			continue
		}
		r.last = reason
		if choice.Index == 0 {
			r.primary = reason
		}
	}
}

func (r streamFinishReason) value() string {
	if reason := strings.TrimSpace(r.primary); reason != "" {
		return reason
	}
	return strings.TrimSpace(r.last)
}

func finishReasonFromStreamChunks(chunks []openai.StreamChunk) string {
	var tracker streamFinishReason
	for _, chunk := range chunks {
		tracker.observe(chunk)
	}
	return tracker.value()
}

func finishReasonFromResponse(response openai.ChatCompletionResponse) string {
	if len(response.Choices) == 0 {
		return ""
	}
	return strings.TrimSpace(response.Choices[0].FinishReason)
}

// finishReasonClass gives dashboards a stable stop/length distinction while
// model_finish_reason retains the provider's exact value for investigation.
func finishReasonClass(reason string) string {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "stop", "end_turn", "stop_sequence", "eos", "completed", "complete":
		return "stop"
	case "length", "max_tokens", "max_output_tokens", "token_limit", "token_limit_exceeded":
		return "length"
	default:
		return ""
	}
}

func addFinishReasonMetadata(meta map[string]any, reason string) {
	if meta == nil {
		return
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return
	}
	meta[modelFinishReasonMetadataKey] = reason
	if class := finishReasonClass(reason); class != "" {
		meta[modelFinishReasonClassMetadataKey] = class
	}
}
