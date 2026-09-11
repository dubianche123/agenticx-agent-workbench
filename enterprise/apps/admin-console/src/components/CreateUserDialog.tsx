"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@agenticx/ui";
import { Copy, Plus } from "lucide-react";
import { useLocale } from "next-intl";
import { adminFetch } from "../lib/admin-client-auth";

export type CreateUserDepartmentOption = { id: string; label: string };

type CreateUserFormValues = {
  displayName: string;
  email: string;
  deptId: string;
  phone: string;
  employeeNo: string;
  jobTitle: string;
  initialPassword: string;
};

type CreateUserResponse = {
  code: string;
  message: string;
  data?: { user?: unknown; initialPassword?: string };
};

function initialValues(defaultDeptId?: string | null): CreateUserFormValues {
  return {
    displayName: "",
    email: "",
    deptId: defaultDeptId ?? "",
    phone: "",
    employeeNo: "",
    jobTitle: "",
    initialPassword: "",
  };
}

export function CreateUserDialog({
  open,
  onOpenChange,
  defaultDeptId,
  departmentOptions,
  title = "新建用户",
  description = "创建后用户会立即进入用户列表；未填写初始密码时系统会自动生成随机密码。",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDeptId?: string | null;
  departmentOptions?: CreateUserDepartmentOption[];
  title?: string;
  description?: string;
  onCreated?: (user: unknown) => void | Promise<void>;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const resolvedTitle = title === "新建用户" ? copy("新建用户", "Create user") : title;
  const resolvedDescription = description === "创建后用户会立即进入用户列表；未填写初始密码时系统会自动生成随机密码。"
    ? copy("创建后用户会立即进入用户列表；未填写初始密码时系统会自动生成随机密码。", "The user is added immediately. Leave the initial password blank to generate a random one.")
    : description;
  const [values, setValues] = useState<CreateUserFormValues>(() => initialValues(defaultDeptId));
  const [fetchedDepartments, setFetchedDepartments] = useState<CreateUserDepartmentOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createdInitialPassword, setCreatedInitialPassword] = useState<string | null>(null);

  const options = useMemo(
    () => (departmentOptions?.length ? departmentOptions : fetchedDepartments),
    [departmentOptions, fetchedDepartments],
  );

  useEffect(() => {
    if (!open) return;
    setValues(initialValues(defaultDeptId));
    setCreatedInitialPassword(null);
  }, [defaultDeptId, open]);

  useEffect(() => {
    if (!open || (departmentOptions && departmentOptions.length > 0)) return;
    let alive = true;
    void (async () => {
      try {
        const response = await adminFetch("/api/admin/departments?shape=flat", { cache: "no-store" });
        const json = (await response.json()) as {
          data?: { items: Array<{ id: string; name: string; path: string }> };
        };
        if (!alive || !response.ok || !json.data?.items) return;
        setFetchedDepartments(
          json.data.items.map((department) => ({
            id: department.id,
            label: `${department.name}（${department.path}）`,
          })),
        );
      } catch {
        // 部门下拉失败时仍允许创建未归属用户。
      }
    })();
    return () => {
      alive = false;
    };
  }, [departmentOptions, open]);

  const update = <K extends keyof CreateUserFormValues>(field: K, value: CreateUserFormValues[K]) => {
    setCreatedInitialPassword(null);
    setValues((current) => ({ ...current, [field]: value }));
  };

  const copyCreatedPassword = async () => {
    if (!createdInitialPassword) return;
    try {
      await navigator.clipboard.writeText(createdInitialPassword);
      toast.success(copy("初始密码已复制", "Initial password copied"));
    } catch {
      toast.error(copy("复制失败，请手动复制密码", "Copy failed; copy the password manually"));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const email = values.email.trim();
    const displayName = values.displayName.trim();
    const initialPassword = values.initialPassword.trim();
    if (!displayName) {
      toast.error(copy("请输入姓名", "Enter a name"));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error(copy("请输入有效邮箱", "Enter a valid email"));
      return;
    }
    if (initialPassword && initialPassword.length < 8) {
      toast.error(copy("初始密码至少 8 位", "The initial password must be at least 8 characters"));
      return;
    }

    setSubmitting(true);
    try {
      const response = await adminFetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          displayName,
          deptId: values.deptId || null,
          phone: values.phone.trim() || null,
          employeeNo: values.employeeNo.trim() || null,
          jobTitle: values.jobTitle.trim() || null,
          initialPassword: initialPassword || undefined,
          status: "active",
        }),
      });
      const json = (await response.json()) as CreateUserResponse;
      if (!response.ok || json.code !== "00000" || !json.data?.user) {
        throw new Error(json.message || copy("创建用户失败", "Failed to create user"));
      }
      setCreatedInitialPassword(json.data.initialPassword ?? null);
      setValues(initialValues(defaultDeptId));
      toast.success(copy("已创建用户", "User created"));
      await onCreated?.(json.data.user);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("创建用户失败", "Failed to create user"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {createdInitialPassword ? (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
              <p className="text-sm font-medium">{copy("初始密码（仅显示一次）", "Initial password (shown once)")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1 text-sm">
                  {createdInitialPassword}
                </code>
                <Button type="button" size="sm" variant="outline" onClick={() => void copyCreatedPassword()}>
                  <Copy className="h-4 w-4" />{copy("复制", "Copy")}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="create-user-display-name">{copy("姓名", "Name")}</Label>
              <Input
                id="create-user-display-name"
                required
                value={values.displayName}
                onChange={(event) => update("displayName", event.target.value)}
                placeholder={copy("例如：张三", "For example: Alex Chen")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-user-email">{copy("邮箱", "Email")}</Label>
              <Input
                id="create-user-email"
                type="email"
                required
                value={values.email}
                onChange={(event) => update("email", event.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-user-department">{copy("所属部门", "Department")}</Label>
              <Select
                value={values.deptId || "__none__"}
                onValueChange={(value) => update("deptId", value === "__none__" ? "" : value)}
              >
                <SelectTrigger id="create-user-department">
                  <SelectValue placeholder={copy("请选择部门", "Select a department")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{copy("未归属部门", "Unassigned")}</SelectItem>
                  {options.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-user-phone">{copy("手机", "Phone")}</Label>
              <Input
                id="create-user-phone"
                value={values.phone}
                onChange={(event) => update("phone", event.target.value)}
                placeholder={copy("可选", "Optional")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-user-employee-no">{copy("工号", "Employee ID")}</Label>
              <Input
                id="create-user-employee-no"
                value={values.employeeNo}
                onChange={(event) => update("employeeNo", event.target.value)}
                placeholder={copy("可选", "Optional")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-user-job-title">{copy("职位", "Job title")}</Label>
              <Input
                id="create-user-job-title"
                value={values.jobTitle}
                onChange={(event) => update("jobTitle", event.target.value)}
                placeholder={copy("可选", "Optional")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="create-user-password">{copy("初始密码", "Initial password")}</Label>
              <Input
                id="create-user-password"
                type="password"
                autoComplete="new-password"
                value={values.initialPassword}
                onChange={(event) => update("initialPassword", event.target.value)}
                placeholder={copy("留空自动生成", "Leave blank to generate")}
              />
            </div>
          </div>

          <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {copy("创建后可在用户详情中单独添加角色授权。", "After creation, add role bindings separately from the user details.")}
          </p>

          <DialogFooter className="mt-4">
            {createdInitialPassword ? (
              <Button type="button" variant="outline" onClick={() => setCreatedInitialPassword(null)}>
                {copy("继续新建", "Create another")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {copy("取消", "Cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              <Plus />
              {submitting ? copy("创建中…", "Creating…") : copy("创建用户", "Create user")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
