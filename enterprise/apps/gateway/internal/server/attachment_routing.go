package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/agenticx/enterprise/gateway/internal/attachment"
	"github.com/agenticx/enterprise/gateway/internal/audit"
	"github.com/agenticx/enterprise/gateway/internal/openai"
	"github.com/agenticx/enterprise/gateway/internal/routing"
)

// HeaderAttachmentRoute is set by the trusted Portal BFF after it has
// inspected the user's attachments. It is still re-authorized here: a stale
// client or a direct caller must not turn a public model into a document
// exception merely by setting a header.
const HeaderAttachmentRoute = "x-agenticx-attachment-route"

const (
	attachmentRoutePrivate = "private"
	attachmentRoutePublic  = "public-override"
)

func attachmentRouteMarker(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(r.Header.Get(HeaderAttachmentRoute)))
}

func privateAttachmentRoute(route string) bool {
	switch strings.ToLower(strings.TrimSpace(route)) {
	case "local", "private-cloud", "private_cloud", "private":
		return true
	default:
		return false
	}
}

// attachmentRelayRoute maps an already validated marker to the channel route
// class that the relay must enforce. It intentionally returns an empty string
// for an absent or unknown marker; unknown markers are rejected by
// enforceAttachmentRouting before a relay can be reached.
func attachmentRelayRoute(r *http.Request) string {
	switch attachmentRouteMarker(r) {
	case attachmentRoutePrivate:
		return "private"
	case attachmentRoutePublic:
		return "third-party"
	default:
		return ""
	}
}

func (s *Server) denyAttachmentRouting(
	w http.ResponseWriter,
	identity requestIdentity,
	r *http.Request,
	decision routing.Decision,
	model string,
	eventType string,
	denial openai.APIError,
	startedAt time.Time,
) bool {
	// A denied marker is still a final routing decision. If its audit cannot be
	// persisted, replace the original denial with an internal fail-closed error
	// rather than silently continuing or claiming the decision was recorded.
	if !s.writeAttachmentRoutingAudit(identity, r, decision, model, eventType, false, startedAt) {
		writeAPIError(w, openai.Internal("附件路由审计失败，本轮未发送"))
		return false
	}
	writeAPIError(w, denial)
	return false
}

// enforceAttachmentRouting verifies the route marker immediately after the
// Gateway has selected a provider and before cross-border checks, quotas, cache
// reads, or an upstream call. It returns false after writing the API response.
//
// The BFF remains responsible for finding the private target. The Gateway is
// responsible for the security boundary: a public exception must be granted
// by the live tenant switch and the caller's capability-pack assignment, and
// every marked decision must be auditable before any model receives data.
func (s *Server) enforceAttachmentRouting(
	w http.ResponseWriter,
	r *http.Request,
	identity requestIdentity,
	decision routing.Decision,
	model string,
	startedAt time.Time,
) bool {
	marker := attachmentRouteMarker(r)
	if marker == "" {
		return true
	}

	switch marker {
	case attachmentRoutePrivate:
		if !privateAttachmentRoute(decision.Route) {
			return s.denyAttachmentRouting(
				w, identity, r, decision, model, "private_route_denied",
				openai.Unavailable("附件私有路由未生效，本轮已停止"), startedAt,
			)
		}
		if !s.writeAttachmentRoutingAudit(identity, r, decision, model, "private_route", true, startedAt) {
			writeAPIError(w, openai.Internal("附件路由审计失败，本轮未发送"))
			return false
		}
		return true

	case attachmentRoutePublic:
		if strings.ToLower(strings.TrimSpace(decision.Route)) != "third-party" {
			return s.denyAttachmentRouting(
				w, identity, r, decision, model, "public_override_denied",
				openai.Forbidden("公网附件例外仅适用于公网模型"), startedAt,
			)
		}
		if s.attachmentPolicy == nil {
			return s.denyAttachmentRouting(
				w, identity, r, decision, model, "public_override_denied",
				openai.Unavailable("附件公网例外策略暂不可用，本轮未发送"), startedAt,
			)
		}
		allowed, err := s.attachmentPolicy.AllowPublicOverride(r.Context(), attachment.Identity{
			TenantID:     identity.TenantID,
			UserID:       identity.UserID,
			UserEmail:    identity.UserEmail,
			DepartmentID: identity.DepartmentID,
		})
		if err != nil {
			if s.logger != nil {
				s.logger.Warn("attachment public override policy unavailable", "error", err)
			}
			// A policy lookup failure is a final denied decision. Record it at the
			// Gateway (the only final authority) before returning 503; the Portal
			// intentionally does not emit a pre-flight accepted event.
			return s.denyAttachmentRouting(
				w, identity, r, decision, model, "public_override_denied",
				openai.Unavailable("附件公网例外策略暂不可用，本轮未发送"), startedAt,
			)
		}
		if !allowed {
			return s.denyAttachmentRouting(
				w, identity, r, decision, model, "public_override_denied",
				openai.Forbidden("您没有本次附件公网例外权限"), startedAt,
			)
		}
		if !s.writeAttachmentRoutingAudit(identity, r, decision, model, "public_override", false, startedAt) {
			writeAPIError(w, openai.Internal("附件路由审计失败，本轮未发送"))
			return false
		}
		return true

	default:
		return s.denyAttachmentRouting(
			w, identity, r, decision, model, "invalid_marker",
			openai.BadRequest("invalid attachment route marker"), startedAt,
		)
	}
}

func (s *Server) writeAttachmentRoutingAudit(
	identity requestIdentity,
	r *http.Request,
	decision routing.Decision,
	model string,
	eventType string,
	privateAccepted bool,
	startedAt time.Time,
) bool {
	if s == nil || s.audit == nil {
		return false
	}
	route := strings.TrimSpace(decision.Route)
	if route == "" {
		route = "third-party"
	}
	policy, err := json.Marshal(map[string]any{
		"source":                 "gateway",
		"decision":               strings.TrimPrefix(eventType, "attachment_routing."),
		"requested_model":        model,
		"route":                  route,
		"provider":               strings.TrimSpace(decision.Provider),
		"private_route_accepted": privateAccepted,
	})
	if err != nil {
		return false
	}
	event := audit.Event{
		ID:            makeID("audit"),
		TenantID:      identity.TenantID,
		EventTime:     time.Now().UTC().Format(time.RFC3339),
		EventType:     "attachment_routing." + strings.TrimPrefix(eventType, "attachment_routing."),
		UserID:        identity.UserID,
		UserEmail:     identity.UserEmail,
		DepartmentID:  identity.DepartmentID,
		SessionID:     identity.SessionID,
		TraceID:       identity.TraceID,
		ClientType:    auditClientType(identity),
		ClientIP:      r.RemoteAddr,
		Provider:      decision.Provider,
		Model:         model,
		Route:         route,
		RoutingPolicy: policy,
		LatencyMS:     time.Since(startedAt).Milliseconds(),
	}
	return s.writeAuditEvent(event) == nil
}
