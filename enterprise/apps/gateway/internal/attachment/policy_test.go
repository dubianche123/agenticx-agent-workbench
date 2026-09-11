package attachment

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/agenticx/enterprise/gateway/internal/database"
)

type policySQLResponder func(query string, args []driver.NamedValue) ([][]driver.Value, error)

type policySQLDriver struct {
	respond policySQLResponder
}

type policySQLConn struct {
	respond policySQLResponder
}

type policySQLRows struct {
	data  [][]driver.Value
	index int
}

var policyDriverSerial atomic.Uint64

func (d policySQLDriver) Open(string) (driver.Conn, error) {
	return &policySQLConn{respond: d.respond}, nil
}

func (c *policySQLConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *policySQLConn) Close() error                        { return nil }
func (c *policySQLConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (c *policySQLConn) QueryContext(
	_ context.Context,
	query string,
	args []driver.NamedValue,
) (driver.Rows, error) {
	data, err := c.respond(query, args)
	if err != nil {
		return nil, err
	}
	return &policySQLRows{data: data}, nil
}

func (r *policySQLRows) Columns() []string { return []string{"value"} }
func (r *policySQLRows) Close() error      { return nil }

func (r *policySQLRows) Next(dest []driver.Value) error {
	if r.index >= len(r.data) {
		return io.EOF
	}
	if len(r.data[r.index]) > 0 {
		dest[0] = r.data[r.index][0]
	}
	r.index++
	return nil
}

func newPolicyForTest(t *testing.T, respond policySQLResponder) *DBPolicy {
	t.Helper()
	driverName := fmt.Sprintf("attachment-policy-%d", policyDriverSerial.Add(1))
	sql.Register(driverName, policySQLDriver{respond: respond})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatalf("open policy stub database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewDBPolicy(&database.Handle{Dialect: database.MySQL, DB: db})
}

func policyIdentity() Identity {
	return Identity{
		TenantID:     "tenant-1",
		UserID:       "user-1",
		UserEmail:    "Alice@Example.COM",
		DepartmentID: "dept-leaf",
	}
}

func foundPolicyRow() [][]driver.Value { return [][]driver.Value{{int64(1)}} }
func noPolicyRows() [][]driver.Value   { return nil }

func assertMySQLPlaceholders(t *testing.T, query string) {
	t.Helper()
	if strings.Contains(query, "$") {
		t.Fatalf("MySQL query contains PostgreSQL placeholder: %q", query)
	}
	if !strings.Contains(query, "?") {
		t.Fatalf("MySQL query lost placeholders: %q", query)
	}
}

func TestDBPolicyUsesCapabilityPacksAsTheOnlyPublicOverrideSwitch(t *testing.T) {
	queries := 0
	policy := newPolicyForTest(t, func(query string, args []driver.NamedValue) ([][]driver.Value, error) {
		queries++
		assertMySQLPlaceholders(t, query)
		if strings.Contains(query, "enterprise_runtime_attachment_routing") {
			return nil, fmt.Errorf("obsolete tenant switch must not be queried: %s", query)
		}
		if !strings.Contains(query, "enterprise_capability_pack_members") ||
			len(args) < 2 || args[1].Value != PublicOverrideCapabilityID {
			return nil, fmt.Errorf("unexpected query: %s args=%v", query, args)
		}
		return noPolicyRows(), nil
	})

	allowed, err := policy.AllowPublicOverride(context.Background(), policyIdentity())
	if err != nil {
		t.Fatalf("AllowPublicOverride error: %v", err)
	}
	if allowed {
		t.Fatal("missing capability-pack grant must deny")
	}
	if queries != 1 {
		t.Fatalf("queries=%d, want only public capability governance", queries)
	}
}

func TestDBPolicyUngovernedPublicCapabilityDeniesWithoutAssignmentLookups(t *testing.T) {
	queries := 0
	policy := newPolicyForTest(t, func(query string, args []driver.NamedValue) ([][]driver.Value, error) {
		queries++
		assertMySQLPlaceholders(t, query)
		switch {
		case strings.Contains(query, "enterprise_capability_pack_members"):
			if len(args) < 2 || args[1].Value != PublicOverrideCapabilityID {
				return nil, fmt.Errorf("unexpected first capability lookup args=%v", args)
			}
			return noPolicyRows(), nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	})

	allowed, err := policy.AllowPublicOverride(context.Background(), policyIdentity())
	if err != nil {
		t.Fatalf("AllowPublicOverride error: %v", err)
	}
	if allowed {
		t.Fatal("an ungoverned public exception must deny")
	}
	if queries != 1 {
		t.Fatalf("queries=%d, want only public governance", queries)
	}
}

func TestDBPolicyMatchesAllUserEmailDepartmentAndGroupAssignments(t *testing.T) {
	var assignedCalls int
	policy := newPolicyForTest(t, func(query string, args []driver.NamedValue) ([][]driver.Value, error) {
		assertMySQLPlaceholders(t, query)
		switch {
		case strings.Contains(query, "enterprise_capability_pack_members") &&
			!strings.Contains(query, "enterprise_capability_assignments"):
			if len(args) < 2 {
				return nil, errors.New("capability governance arguments missing")
			}
			return foundPolicyRow(), nil
		case strings.Contains(query, "enterprise_user_opt_outs"):
			return noPolicyRows(), nil
		case strings.Contains(query, "FROM departments"):
			if len(args) < 2 {
				return nil, errors.New("department arguments missing")
			}
			switch args[1].Value {
			case "dept-leaf":
				return [][]driver.Value{{"dept-root"}}, nil
			case "dept-root":
				return [][]driver.Value{{""}}, nil
			default:
				return nil, fmt.Errorf("unexpected department id %v", args[1].Value)
			}
		case strings.Contains(query, "enterprise_user_group_members"):
			return [][]driver.Value{{"group-a"}, {"group-b"}}, nil
		case strings.Contains(query, "enterprise_capability_assignments"):
			assignedCalls++
			if len(args) < 3 {
				return nil, errors.New("assignment arguments missing")
			}
			if args[1].Value != PublicOverrideCapabilityID && args[1].Value != AttachmentRoutingCapabilityID {
				return nil, fmt.Errorf("unexpected capability id %v", args[1].Value)
			}
			keys := map[string]bool{}
			for _, arg := range args[2:] {
				key, ok := arg.Value.(string)
				if !ok {
					return nil, fmt.Errorf("assignment key type %T", arg.Value)
				}
				keys[key] = true
			}
			for _, want := range []string{
				"all",
				"user-1",
				"email:alice@example.com",
				"dept:dept-leaf",
				"dept:dept-root",
				"group:group-a",
				"group:group-b",
			} {
				if !keys[want] {
					t.Errorf("assignment keys missing %q; got %v", want, keys)
				}
			}
			return foundPolicyRow(), nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	})

	allowed, err := policy.AllowPublicOverride(context.Background(), policyIdentity())
	if err != nil {
		t.Fatalf("AllowPublicOverride error: %v", err)
	}
	if !allowed {
		t.Fatal("assigned user must be allowed")
	}
	if assignedCalls != 2 {
		t.Fatalf("assignment calls=%d, want base routing + public exception", assignedCalls)
	}
}

func TestDBPolicyOptOutDeniesBeforeAssignmentLookup(t *testing.T) {
	assignmentReached := false
	policy := newPolicyForTest(t, func(query string, args []driver.NamedValue) ([][]driver.Value, error) {
		assertMySQLPlaceholders(t, query)
		switch {
		case strings.Contains(query, "enterprise_capability_pack_members") &&
			!strings.Contains(query, "enterprise_capability_assignments"):
			return foundPolicyRow(), nil
		case strings.Contains(query, "enterprise_user_opt_outs"):
			if len(args) < 3 || args[2].Value != PublicOverrideCapabilityID {
				return nil, fmt.Errorf("unexpected opt-out args=%v", args)
			}
			return foundPolicyRow(), nil
		case strings.Contains(query, "enterprise_capability_assignments"):
			assignmentReached = true
			return foundPolicyRow(), nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	})

	allowed, err := policy.AllowPublicOverride(context.Background(), policyIdentity())
	if err != nil {
		t.Fatalf("AllowPublicOverride error: %v", err)
	}
	if allowed {
		t.Fatal("opted-out user must be denied")
	}
	if assignmentReached {
		t.Fatal("opt-out must short-circuit before assignment lookup")
	}
}

func TestDBPolicyDatabaseErrorFailsClosed(t *testing.T) {
	boom := errors.New("database connection reset")
	policy := newPolicyForTest(t, func(query string, _ []driver.NamedValue) ([][]driver.Value, error) {
		assertMySQLPlaceholders(t, query)
		if !strings.Contains(query, "enterprise_capability_pack_members") {
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
		return nil, boom
	})

	allowed, err := policy.AllowPublicOverride(context.Background(), policyIdentity())
	if err == nil {
		t.Fatal("database error must be returned")
	}
	if allowed {
		t.Fatal("database error must fail closed")
	}
}
