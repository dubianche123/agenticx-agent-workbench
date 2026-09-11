/**
 * 用户组不是额度主体，只是批量编辑入口。
 *
 * 返回一份新的「用户 id → 个人规则」映射：有规则就逐人写入，没有规则就逐人删除、
 * 恢复继承。这里刻意没有 groupId 参数，防止以后又把它误做成共享组额度。
 */
export function withMemberRuleBatch<T>(
  current: Readonly<Record<string, T>>,
  memberIds: readonly string[],
  rule: T | null,
): Record<string, T> {
  const next = { ...current };
  for (const memberId of new Set(memberIds)) {
    if (rule === null) delete next[memberId];
    else next[memberId] = rule;
  }
  return next;
}
