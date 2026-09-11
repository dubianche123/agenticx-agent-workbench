package attachment

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/agenticx/enterprise/gateway/internal/database"
)

// AttachmentRoutingCapabilityID is the stable capability-pack id for the
// automatic document-containment route. Legacy tenants where no pack governs
// this feature remain allowed, matching the Portal's migration semantics.
const AttachmentRoutingCapabilityID = "feature:attachment_routing"

// PublicOverrideCapabilityID is the stable capability-pack id for the one
// operation that relaxes document containment. It is deliberately kept
// separate from attachment_routing: the latter enables the automatic private
// route, while this id grants an individual the ability to choose public.
const PublicOverrideCapabilityID = "feature:attachment_public_override"

const (
	allMembersAssignmentKey = "all"
	maxDepartmentDepth      = 32
)

// Identity contains only the claims needed by the attachment policy. Keeping
// this type in the policy package prevents the gateway HTTP handler identity
// from becoming part of the database policy API.
type Identity struct {
	TenantID     string
	UserID       string
	UserEmail    string
	DepartmentID string
}

// PublicOverrideAuthorizer is the gateway's second (authoritative) check for
// a request that asks to keep a document on a public model.
type PublicOverrideAuthorizer interface {
	AllowPublicOverride(ctx context.Context, identity Identity) (bool, error)
}

// DBPolicy reads the same capability-pack tables used by the Portal. There is
// intentionally no cache here: removing an individual's
// exception must take effect on the next gateway request, even if a stale
// browser or Desktop token still contains the old bootstrap response.
type DBPolicy struct {
	db *database.Handle
}

func NewDBPolicy(db *database.Handle) *DBPolicy {
	return &DBPolicy{db: db}
}

// AllowPublicOverride implements the full fail-closed policy:
//  1. if attachment_routing is governed, the caller must be assigned to it;
//  2. an active capability pack must govern the exception feature;
//  3. the caller must not have opted out; and
//  4. an active pack containing the feature must be assigned to this caller.
//
// There is deliberately no tenant-level override switch: capability packs are
// the single source of truth for who may choose a public model. Any database
// failure is returned so the HTTP layer can stop before an upstream call.
func (p *DBPolicy) AllowPublicOverride(ctx context.Context, identity Identity) (bool, error) {
	if p == nil || p.db == nil {
		return false, errors.New("attachment policy database unavailable")
	}
	tenantID := strings.TrimSpace(identity.TenantID)
	userID := strings.TrimSpace(identity.UserID)
	if tenantID == "" || userID == "" {
		return false, nil
	}

	publicGoverned, err := p.governed(ctx, tenantID, PublicOverrideCapabilityID)
	if err != nil {
		return false, fmt.Errorf("capability governance: %w", err)
	}
	// Unlike legacy capabilities, this new permission must never fail open for
	// a tenant that has not explicitly configured a capability pack.
	if !publicGoverned {
		return false, nil
	}

	routingGoverned, err := p.governed(ctx, tenantID, AttachmentRoutingCapabilityID)
	if err != nil {
		return false, fmt.Errorf("attachment routing governance: %w", err)
	}

	publicOptedOut, err := p.optedOut(ctx, tenantID, userID, PublicOverrideCapabilityID)
	if err != nil {
		return false, fmt.Errorf("opt-out: %w", err)
	}
	if publicOptedOut {
		return false, nil
	}
	if routingGoverned {
		routingOptedOut, err := p.optedOut(ctx, tenantID, userID, AttachmentRoutingCapabilityID)
		if err != nil {
			return false, fmt.Errorf("attachment routing opt-out: %w", err)
		}
		if routingOptedOut {
			return false, nil
		}
	}

	keys, err := p.assignmentKeys(ctx, tenantID, identity)
	if err != nil {
		return false, fmt.Errorf("assignment keys: %w", err)
	}
	if routingGoverned {
		routingAssigned, err := p.assigned(ctx, tenantID, AttachmentRoutingCapabilityID, keys)
		if err != nil {
			return false, fmt.Errorf("attachment routing assignment: %w", err)
		}
		if !routingAssigned {
			return false, nil
		}
	}
	assigned, err := p.assigned(ctx, tenantID, PublicOverrideCapabilityID, keys)
	if err != nil {
		return false, fmt.Errorf("assignment: %w", err)
	}
	return assigned, nil
}

func (p *DBPolicy) governed(ctx context.Context, tenantID, capabilityID string) (bool, error) {
	row, err := p.db.QueryRowContext(ctx, `
SELECT 1
FROM enterprise_capability_pack_members m
JOIN enterprise_capability_packs p ON p.id = m.pack_id
WHERE p.tenant_id = ? AND m.capability_id = ?
	LIMIT 1`, tenantID, capabilityID)
	if err != nil {
		return false, err
	}
	return scanExists(row)
}

func (p *DBPolicy) optedOut(ctx context.Context, tenantID, userID, capabilityID string) (bool, error) {
	row, err := p.db.QueryRowContext(ctx, `
SELECT 1
FROM enterprise_user_opt_outs
WHERE tenant_id = ? AND user_id = ? AND subject = ?
	LIMIT 1`, tenantID, userID, capabilityID)
	if err != nil {
		return false, err
	}
	return scanExists(row)
}

func (p *DBPolicy) assigned(ctx context.Context, tenantID, capabilityID string, keys []string) (bool, error) {
	if len(keys) == 0 {
		return false, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",")
	args := make([]any, 0, len(keys)+2)
	args = append(args, tenantID, capabilityID)
	for _, key := range keys {
		args = append(args, key)
	}
	row, err := p.db.QueryRowContext(ctx, `
SELECT 1
FROM enterprise_capability_pack_members m
JOIN enterprise_capability_packs p ON p.id = m.pack_id AND p.status = 'active'
JOIN enterprise_capability_assignments a ON a.pack_id = p.id AND a.tenant_id = p.tenant_id
WHERE p.tenant_id = ? AND m.capability_id = ? AND a.assignment_key IN (`+placeholders+`)
LIMIT 1`, args...)
	if err != nil {
		return false, err
	}
	return scanExists(row)
}

// assignmentKeys mirrors the portal's resolveAssignmentKeysForUser. The order
// is stable to make SQL-driver based tests and audit diagnostics easy to
// inspect; the database query itself is an IN lookup.
func (p *DBPolicy) assignmentKeys(
	ctx context.Context,
	tenantID string,
	identity Identity,
) ([]string, error) {
	keys := []string{allMembersAssignmentKey}
	userID := strings.TrimSpace(identity.UserID)
	if userID != "" {
		keys = append(keys, userID)
	}
	if email := strings.ToLower(strings.TrimSpace(identity.UserEmail)); email != "" {
		keys = append(keys, "email:"+email)
	}
	if deptID := strings.TrimSpace(identity.DepartmentID); deptID != "" {
		ancestors, err := p.departmentChain(ctx, tenantID, deptID)
		if err != nil {
			return nil, err
		}
		for _, id := range ancestors {
			keys = append(keys, "dept:"+id)
		}
	}
	groups, err := p.groupIDs(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	for _, id := range groups {
		keys = append(keys, "group:"+id)
	}
	return keys, nil
}

func (p *DBPolicy) departmentChain(ctx context.Context, tenantID, deptID string) ([]string, error) {
	out := make([]string, 0, 4)
	seen := map[string]bool{}
	current := strings.TrimSpace(deptID)
	for i := 0; i < maxDepartmentDepth && current != "" && !seen[current]; i++ {
		seen[current] = true
		row, err := p.db.QueryRowContext(ctx, `
SELECT COALESCE(parent_id, '')
FROM departments
WHERE tenant_id = ? AND id = ?
LIMIT 1`, tenantID, current)
		if err != nil {
			return nil, err
		}
		var parent string
		if err := row.Scan(&parent); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				break
			}
			return nil, err
		}
		out = append(out, current)
		current = strings.TrimSpace(parent)
	}
	return out, nil
}

func (p *DBPolicy) groupIDs(ctx context.Context, tenantID, userID string) ([]string, error) {
	if userID == "" {
		return nil, nil
	}
	rows, err := p.db.QueryContext(ctx, `
SELECT m.group_id
FROM enterprise_user_group_members m
JOIN enterprise_user_groups g ON g.id = m.group_id
WHERE g.tenant_id = ? AND m.user_id = ?`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

func scanExists(row *sql.Row) (bool, error) {
	var one int
	if err := row.Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
