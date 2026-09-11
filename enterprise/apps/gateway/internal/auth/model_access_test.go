package auth

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeModelAccessReader struct {
	enabled     map[string][]string
	ancestors   map[string][]string
	groups      map[string][]string
	optOuts     map[string][]string
	assignments map[string]map[string][]string
	errEnabled  error
	errDept     error
	errGroups   error
	errOptOuts  error
	errAssign   error
	calls       int
}

func (f *fakeModelAccessReader) EnabledModelIDs(ctx context.Context, tenantID string) ([]string, error) {
	f.calls++
	if f.errEnabled != nil {
		return nil, f.errEnabled
	}
	return append([]string(nil), f.enabled[tenantID]...), nil
}

func (f *fakeModelAccessReader) DepartmentAncestors(ctx context.Context, tenantID, deptID string) ([]string, error) {
	f.calls++
	if f.errDept != nil {
		return nil, f.errDept
	}
	return append([]string(nil), f.ancestors[tenantID+"/"+deptID]...), nil
}

func (f *fakeModelAccessReader) GroupIDsForUser(ctx context.Context, tenantID, userID string) ([]string, error) {
	f.calls++
	if f.errGroups != nil {
		return nil, f.errGroups
	}
	return append([]string(nil), f.groups[tenantID+"/"+userID]...), nil
}

func (f *fakeModelAccessReader) ModelOptOuts(ctx context.Context, tenantID, userID string) ([]string, error) {
	f.calls++
	if f.errOptOuts != nil {
		return nil, f.errOptOuts
	}
	return append([]string(nil), f.optOuts[tenantID+"/"+userID]...), nil
}

func (f *fakeModelAccessReader) AssignmentsForKeys(
	ctx context.Context,
	tenantID string,
	assignmentKeys []string,
) (map[string][]string, error) {
	f.calls++
	if f.errAssign != nil {
		return nil, f.errAssign
	}
	src := f.assignments[tenantID]
	out := map[string][]string{}
	for _, key := range assignmentKeys {
		if vals, ok := src[key]; ok {
			out[key] = append([]string(nil), vals...)
		}
	}
	return out, nil
}

func TestComputeEffectiveModelIDsCascading(t *testing.T) {
	all := []string{"p/a", "p/b", "p/c", "p/d"}

	t.Run("no config inherits all enabled", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{}, nil, "u1", "a@x.invalid", nil, nil)
		if len(got) != 4 {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("dept root then child intersect", func(t *testing.T) {
		// leaf-first: child, root
		got := computeEffectiveModelIDs(all, map[string][]string{
			"dept:root":  {"p/a", "p/b", "p/c"},
			"dept:child": {"p/b", "p/c", "p/d"},
		}, []string{"child", "root"}, "u1", "", nil, nil)
		if _, ok := got["p/b"]; !ok {
			t.Fatalf("expected p/b in %v", got)
		}
		if _, ok := got["p/c"]; !ok {
			t.Fatalf("expected p/c in %v", got)
		}
		if _, ok := got["p/a"]; ok {
			t.Fatalf("p/a should be removed by child intersect")
		}
		if _, ok := got["p/d"]; ok {
			t.Fatalf("p/d never in root set")
		}
	})

	t.Run("user id narrows", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{
			"u1": {"p/a", "p/b"},
		}, nil, "u1", "a@x.invalid", nil, nil)
		if len(got) != 2 {
			t.Fatalf("got %v", got)
		}
		if _, ok := got["p/c"]; ok {
			t.Fatal("p/c should be excluded")
		}
	})

	t.Run("email key compatible", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{
			"email:a@x.invalid": {"p/c"},
		}, nil, "u1", "A@X.invalid", nil, nil)
		if len(got) != 1 || got["p/c"] != struct{}{} {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("user id and email union then intersect", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{
			"u1":                {"p/a"},
			"email:a@x.invalid": {"p/b"},
		}, nil, "u1", "a@x.invalid", nil, nil)
		if len(got) != 2 {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("disabled never appears in allEnabled", func(t *testing.T) {
		got := computeEffectiveModelIDs([]string{"p/a"}, map[string][]string{
			"u1": {"p/a", "p/disabled"},
		}, nil, "u1", "", nil, nil)
		if _, ok := got["p/disabled"]; ok {
			t.Fatal("disabled model must not be allowed")
		}
	})

	t.Run("user and group assignments union before the department ceiling", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{
			"dept:child": {"p/a", "p/b", "p/c"},
			"u1":         {"p/a"},
			"group:g1":   {"p/b", "p/d"},
		}, []string{"child"}, "u1", "a@x.invalid", []string{"g1"}, nil)
		if len(got) != 2 {
			t.Fatalf("got %v", got)
		}
		if _, ok := got["p/a"]; !ok {
			t.Fatalf("expected personal model in %v", got)
		}
		if _, ok := got["p/b"]; !ok {
			t.Fatalf("expected group model in %v", got)
		}
		if _, ok := got["p/d"]; ok {
			t.Fatal("group assignment must not escape the department ceiling")
		}
	})

	t.Run("personal opt-out removes an inherited or assigned model", func(t *testing.T) {
		got := computeEffectiveModelIDs(all, map[string][]string{
			"group:g1": {"p/a", "p/b"},
		}, nil, "u1", "a@x.invalid", []string{"g1"}, []string{"p/b"})
		if len(got) != 1 {
			t.Fatalf("got %v", got)
		}
		if _, ok := got["p/a"]; !ok {
			t.Fatalf("expected p/a in %v", got)
		}
		if _, ok := got["p/b"]; ok {
			t.Fatal("opted-out model must be denied")
		}
	})
}

func TestDBManagedModelAuthorizerAllowDenyAndCache(t *testing.T) {
	fake := &fakeModelAccessReader{
		enabled: map[string][]string{
			"t1": {"prov/a", "prov/b"},
			"t2": {"prov/z"},
		},
		ancestors: map[string][]string{},
		groups:    map[string][]string{},
		optOuts:   map[string][]string{},
		assignments: map[string]map[string][]string{
			"t1": {"u1": {"prov/a"}},
		},
	}
	authz := NewManagedModelAuthorizerWithReader(fake, 50*time.Millisecond)

	ok, err := authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1", UserEmail: "a@x.invalid",
	}, "prov/a")
	if err != nil || !ok {
		t.Fatalf("expected allow, ok=%v err=%v", ok, err)
	}
	ok, err = authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1",
	}, "prov/b")
	if err != nil || ok {
		t.Fatalf("expected deny prov/b")
	}
	ok, err = authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t2", UserID: "u1",
	}, "prov/a")
	if err != nil || ok {
		t.Fatalf("tenant A assignment must not authorize tenant B")
	}

	callsBefore := fake.calls
	_, _ = authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1", UserEmail: "a@x.invalid",
	}, "prov/a")
	if fake.calls != callsBefore {
		t.Fatalf("expected cache hit, calls %d -> %d", callsBefore, fake.calls)
	}

	time.Sleep(60 * time.Millisecond)
	_, _ = authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1", UserEmail: "a@x.invalid",
	}, "prov/a")
	if fake.calls <= callsBefore {
		t.Fatal("expected reload after TTL")
	}
}

func TestDBManagedModelAuthorizerUsesGroupAssignmentsAndModelOptOuts(t *testing.T) {
	fake := &fakeModelAccessReader{
		enabled: map[string][]string{
			"t1": {"prov/a", "prov/b"},
		},
		ancestors: map[string][]string{},
		groups: map[string][]string{
			"t1/u1": {"g1"},
		},
		optOuts: map[string][]string{
			"t1/u1": {"prov/b"},
		},
		assignments: map[string]map[string][]string{
			"t1": {"group:g1": {"prov/a", "prov/b"}},
		},
	}
	authz := NewManagedModelAuthorizerWithReader(fake, time.Second)

	ok, err := authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1", UserEmail: "a@x.invalid",
	}, "prov/a")
	if err != nil || !ok {
		t.Fatalf("expected group-assigned model, ok=%v err=%v", ok, err)
	}
	ok, err = authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1", UserEmail: "a@x.invalid",
	}, "prov/b")
	if err != nil || ok {
		t.Fatalf("expected opted-out group model to be denied, ok=%v err=%v", ok, err)
	}
}

func TestDBManagedModelAuthorizerFailClosed(t *testing.T) {
	fake := &fakeModelAccessReader{errEnabled: errors.New("db down")}
	authz := NewManagedModelAuthorizerWithReader(fake, time.Second)
	ok, err := authz.IsAllowed(context.Background(), ManagedModelIdentity{
		TenantID: "t1", UserID: "u1",
	}, "prov/a")
	if err == nil || ok {
		t.Fatalf("expected fail closed, ok=%v err=%v", ok, err)
	}
}

func TestManagedModelCacheTTLDefault(t *testing.T) {
	t.Setenv("GATEWAY_MANAGED_MODEL_CACHE_TTL", "")
	if managedModelCacheTTLFromEnv() != 15*time.Second {
		t.Fatalf("expected 15s default")
	}
}
