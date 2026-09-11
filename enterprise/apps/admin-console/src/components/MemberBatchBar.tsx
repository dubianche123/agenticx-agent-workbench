"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@agenticx/ui";
import { Loader2, X } from "lucide-react";
import { useLocale } from "next-intl";

import { adminFetch } from "../lib/admin-client-auth";
import { versionedCapabilityPackPatch } from "../lib/capability-pack-concurrency";

type PackRecord = {
  id: string;
  displayName: string;
  status: string;
  assignmentKeys: string[];
  updatedAt: string;
};

export type BatchBarDepartment = { id: string; name: string; path?: string };

/** Select 不接受空字符串做值，「移出部门」用哨兵表示。 */
const NO_DEPT_VALUE = "__none__";

type Envelope<T> = { code: string; message: string; data?: T };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const json = (await response.json()) as Envelope<T>;
  if (!response.ok || json.code !== "00000") throw new Error(json.message || fallback);
  return json.data as T;
}

/**
 * 把一组用户 id 并入/移出某个分配集合。
 *
 * 分配接口是整集替换——按它自己的注释，「让前端 diff 两个集合再发细粒度调用，正是
 * 『只改了一半』的成因」。所以这里也读全量、算好再整集写回，不拼增量。
 */
export function nextKeys(current: readonly string[], userIds: readonly string[], grant: boolean): string[] {
  const set = new Set(current);
  for (const id of userIds) {
    if (grant) set.add(id);
    else set.delete(id);
  }
  return [...set];
}

/**
 * 成员列表的批量操作条。
 *
 * 「把一堆人一块改」这件事在这里发生，而不是靠让用户组去持有一份配置——组仍然是授予，
 * 改组会实时影响所有成员；这条操作条改的是被选中的这几个人自己那一份。两者不冲突：
 * 一个是长效规则，一个是临时的一把。选中的这批人本身就是「一伙人」时，「存为用户组」
 * 把这一把变成长效的那一个，不用再去另一个页面把人重挑一遍。
 *
 * 「移动到部门」也在这条上：调部门原本只能一个个点开详情改，人一多就没法用。
 *
 * 这里不再有联网搜索/深度研究的开关。那两个按钮写的是 enterprise_feature_assignments，
 * 而这两项功能并入能力包之后，运行时只认包——按下去会提示成功，员工那边却什么都没变。
 * 要调这两项，走「绑定能力包」，或者进包里改。
 */
export function MemberBatchBar({
  selectedIds,
  departments,
  onRequestMove,
  onClear,
  onChanged,
}: {
  selectedIds: readonly string[];
  departments: readonly BatchBarDepartment[];
  /**
   * 只是「请求」移动，真正的确认弹窗和写入在成员页里——拖放落到组织树上走的是同一条路，
   * 两个入口共用一个确认框，才不会出现「拖着走有二次确认、点按钮直接就改了」。
   */
  onRequestMove: (deptId: string | null) => void;
  onClear: () => void;
  onChanged: () => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [busy, setBusy] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState("");
  const [groupName, setGroupName] = useState("");
  const [packId, setPackId] = useState("");
  const [moveDeptId, setMoveDeptId] = useState("");
  const [packs, setPacks] = useState<PackRecord[]>([]);

  // 包列表只在真的选了人之后才拉：没人选时这条操作条根本不显示。
  useEffect(() => {
    if (selectedIds.length === 0 || packs.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await readJson<{ packs: PackRecord[] }>(
          await adminFetch("/api/admin/capability-packs", { cache: "no-store" }),
          copy("读取能力包失败", "Failed to load capability packs"),
        );
        if (!cancelled) setPacks(data.packs.filter((pack) => pack.status === "active"));
      } catch {
        // 拉不到就只是没有包可选，其余批量操作照常可用。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packs.length, selectedIds.length]);

  const run = useCallback(
    async (label: string, task: () => Promise<void>, successText?: string) => {
      setBusy(label);
      try {
        await task();
        toast.success(successText ?? `${label} ${selectedIds.length} ${copy("位成员已完成", "members updated")}`);
        onChanged();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `${label} ${copy("失败", "failed")}`);
      } finally {
        setBusy(null);
      }
    },
    [onChanged, selectedIds.length],
  );

  const createGroup = useCallback(
    () =>
      run(
        copy("创建用户组", "Create user group"),
        async () => {
          const name = groupName.trim();
          if (!name) throw new Error(copy("请填组名", "Enter a group name"));
          await readJson(
            await adminFetch("/api/admin/user-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, memberIds: [...selectedIds] }),
            }),
            copy("创建用户组失败", "Failed to create user group"),
          );
          setGroupName("");
        },
        `${copy("已创建用户组", "Created user group")} “${groupName.trim()}” · ${selectedIds.length} ${copy("位成员", "members")}`,
      ),
    [groupName, run, selectedIds],
  );

  const bindPack = useCallback(
    () =>
      run(copy("绑定能力包", "Bind capability pack"), async () => {
        // 重新拉一次而不是用缓存里的：整集写回时必须基于当下的分配，否则会把别人刚
        // 加进去的那批悄悄抹掉。
        const latest = await readJson<{ packs: PackRecord[] }>(
          await adminFetch("/api/admin/capability-packs", { cache: "no-store" }),
          copy("读取能力包失败", "Failed to load capability packs"),
        );
        const target = latest.packs.find((pack) => pack.id === packId);
        if (!target) throw new Error(copy("能力包不存在", "Capability pack not found"));
        await readJson(
          await adminFetch(`/api/admin/capability-packs/${encodeURIComponent(packId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              versionedCapabilityPackPatch(target.updatedAt, {
                assignmentKeys: nextKeys(target.assignmentKeys, selectedIds, true),
              }),
            ),
          }),
          copy("保存能力包失败", "Failed to save capability pack"),
        );
      }),
    [packId, run, selectedIds],
  );

  const applyQuota = useCallback(
    () =>
      run(copy("设置额度", "Set quota"), async () => {
        const monthlyTokens = Number(quotaDraft);
        if (!Number.isFinite(monthlyTokens) || monthlyTokens < 0) throw new Error(copy("额度需为非负数字", "Quota must be a non-negative number"));
        // 额度是一人一条规则，没有批量接口；逐个写，任何一个失败都要说出来是哪个。
        const failures: string[] = [];
        for (const id of selectedIds) {
          try {
            await readJson(
              await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/quota`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ monthlyTokens }),
              }),
              copy("保存额度失败", "Failed to save quota"),
            );
          } catch {
            failures.push(id);
          }
        }
        if (failures.length > 0) throw new Error(`${failures.length} ${copy("位成员未成功，其余已生效", "members failed; the rest were applied")}`);
      }),
    [quotaDraft, run, selectedIds],
  );

  if (selectedIds.length === 0) return null;

  return (
    <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
      <span className="text-sm font-medium">{copy("已选", "Selected")} {selectedIds.length} {copy("人", "members")}</span>
      <span className="h-4 w-px bg-border" />

      <Input
        className="h-8 w-36"
        placeholder={copy("新用户组名称", "New group name")}
        value={groupName}
        onChange={(event) => setGroupName(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null || groupName.trim() === ""}
        onClick={() => void createGroup()}
      >
        {copy("存为用户组", "Save as group")}
      </Button>

      <span className="h-4 w-px bg-border" />
      <Select value={moveDeptId} onValueChange={setMoveDeptId}>
        <SelectTrigger className="h-8 w-44">
          <SelectValue placeholder={copy("移动到部门", "Move to department")} />
        </SelectTrigger>
        <SelectContent>
          {departments.map((dept) => (
            <SelectItem key={dept.id} value={dept.id}>
              {dept.path || dept.name}
            </SelectItem>
          ))}
          <SelectItem value={NO_DEPT_VALUE}>{copy("（移出部门）", "(Remove from department)")}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null || !moveDeptId}
        onClick={() => onRequestMove(moveDeptId === NO_DEPT_VALUE ? null : moveDeptId)}
      >
        {copy("移动", "Move")}
      </Button>

      <span className="h-4 w-px bg-border" />
      <Select value={packId} onValueChange={setPackId}>
        <SelectTrigger className="h-8 w-44">
          <SelectValue placeholder={copy("选择能力包", "Select capability pack")} />
        </SelectTrigger>
        <SelectContent>
          {packs.map((pack) => (
            <SelectItem key={pack.id} value={pack.id}>
              {pack.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" disabled={busy !== null || !packId} onClick={() => void bindPack()}>
        {copy("绑定", "Bind")}
      </Button>

      <span className="h-4 w-px bg-border" />
      <Input
        className="h-8 w-32"
        inputMode="numeric"
        placeholder={copy("月额度 Token", "Monthly Token quota")}
        value={quotaDraft}
        onChange={(event) => setQuotaDraft(event.target.value)}
      />
      <Button size="sm" variant="outline" disabled={busy !== null || quotaDraft.trim() === ""} onClick={() => void applyQuota()}>
        {copy("设置额度", "Set quota")}
      </Button>

      {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} disabled={busy !== null}>
        <X className="h-4 w-4" />{copy("取消选择", "Clear selection")}
      </Button>
    </div>
  );
}
