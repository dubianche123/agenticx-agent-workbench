import type { Avatar } from "../../store";
import { GROUP_TEMPLATES, type GroupTemplate } from "../groups/group-templates";

export type OfficialExpertTemplate = {
  id: string;
  sourceAvatar: Avatar;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tags: string[];
};

export type OfficialPlazaTemplate = {
  id: string;
  source: "official";
  kind: PortablePackageKind;
  title: string;
  description: string;
  ownerDisplayName: string;
  expertTemplate?: OfficialExpertTemplate;
  groupTemplate?: GroupTemplate;
};

type OfficialExpertCreationApi = Pick<Window["agenticxDesktop"], "createAvatar">;

const BUILTIN_TAG_PREFIX = "builtin:";

function normalizeExpertName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function officialTemplateId(avatar: Avatar): string {
  const tag = (avatar.tags ?? []).find((item) => item.startsWith(BUILTIN_TAG_PREFIX));
  return (tag?.slice(BUILTIN_TAG_PREFIX.length) || avatar.id).trim();
}

export function isOfficialExpertTemplateAvatar(avatar: Avatar): boolean {
  return avatar.createdBy === "builtin"
    || (avatar.tags ?? []).some((tag) => tag.startsWith(BUILTIN_TAG_PREFIX));
}

export function listOfficialExpertTemplates(
  avatars: readonly Avatar[],
): OfficialExpertTemplate[] {
  return avatars
    .filter(isOfficialExpertTemplateAvatar)
    .map((avatar) => ({
      id: officialTemplateId(avatar),
      sourceAvatar: avatar,
      name: avatar.name,
      role: avatar.role,
      description: avatar.description ?? "",
      systemPrompt: avatar.systemPrompt ?? "",
      tags: (avatar.tags ?? []).filter(
        (tag) => !tag.startsWith(BUILTIN_TAG_PREFIX) && tag !== "内置",
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function standaloneMemberPrompt(member: GroupTemplate["members"][number]): string {
  const lines = member.systemPrompt.split(/\r?\n/);
  const contractStart = lines.findIndex((line) => line.trim() === "核心职责：");
  const contract = contractStart >= 0 ? lines.slice(contractStart) : lines.slice(1);
  return [
    `你是「${member.name}」，一名${member.role}。`,
    member.description,
    "",
    ...contract,
  ]
    .join("\n")
    .trim();
}

function syntheticMemberAvatar(member: GroupTemplate["members"][number]): Avatar {
  const systemPrompt = standaloneMemberPrompt(member);
  return {
    id: `official-group-member:${member.id}`,
    name: member.name,
    role: member.role,
    avatarUrl: "",
    pinned: false,
    createdBy: "builtin",
    description: member.description,
    systemPrompt,
    tags: ["builtin:group-member", ...member.tags],
  };
}

/**
 * The member definitions shipped with a team template are also useful as
 * standalone experts. Keep the first definition for a name so a person can
 * add one clear expert instead of seeing duplicates from several workflows.
 */
export function listOfficialGroupMemberTemplates(): OfficialExpertTemplate[] {
  const seenNames = new Set<string>();
  const templates: OfficialExpertTemplate[] = [];

  for (const group of GROUP_TEMPLATES) {
    for (const member of group.members) {
      const name = member.name.trim();
      const key = normalizeExpertName(name);
      if (!name || seenNames.has(key)) continue;
      seenNames.add(key);
      const sourceAvatar = syntheticMemberAvatar(member);
      templates.push({
        id: `group-member:${member.id}`,
        sourceAvatar,
        name,
        role: member.role.trim(),
        description: member.description.trim(),
        systemPrompt: sourceAvatar.systemPrompt ?? "",
        tags: [...member.tags],
      });
    }
  }

  return templates.sort((left, right) => left.name.localeCompare(right.name));
}

function uniqueOfficialExpertTemplates(
  templates: readonly OfficialExpertTemplate[],
): OfficialExpertTemplate[] {
  const seenNames = new Set<string>();
  return templates.filter((template) => {
    const key = normalizeExpertName(template.name);
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}

export function listOfficialPlazaTemplates(
  avatars: readonly Avatar[],
): OfficialPlazaTemplate[] {
  const expertTemplates: OfficialPlazaTemplate[] = uniqueOfficialExpertTemplates([
    ...listOfficialExpertTemplates(avatars),
    ...listOfficialGroupMemberTemplates(),
  ]).map((template) => ({
      id: `official:expert:${template.id}`,
      source: "official",
      kind: "expert",
      title: template.name,
      description: template.description,
      ownerDisplayName: "AgenticX 官方",
      expertTemplate: template,
    }));
  const groupTemplates: OfficialPlazaTemplate[] = GROUP_TEMPLATES.map((template) => ({
    id: `official:group:${template.id}`,
    source: "official",
    kind: "group",
    title: template.name,
    description: template.description,
    ownerDisplayName: "AgenticX 官方",
    groupTemplate: template,
  }));
  return [...expertTemplates, ...groupTemplates];
}

export function nextAvailableOfficialExpertName(
  baseName: string,
  existingNames: readonly string[],
): string {
  const base = baseName.trim() || "数字专家";
  const occupied = new Set(
    existingNames.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean),
  );
  if (!occupied.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (occupied.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

export async function createExpertFromOfficialTemplate({
  template,
  existingNames,
  api,
}: {
  template: OfficialExpertTemplate;
  existingNames: readonly string[];
  api: OfficialExpertCreationApi;
}) {
  const name = nextAvailableOfficialExpertName(template.name, existingNames);
  const tags = Array.from(new Set(["官方模板", ...template.tags])).slice(0, 8);
  const result = await api.createAvatar({
    name,
    role: template.role,
    description: template.description,
    system_prompt: template.systemPrompt,
    tags,
    created_by: `official_template:${template.id}`,
  });
  if (!result.ok) {
    throw new Error(result.error || `添加数字专家「${template.name}」失败。`);
  }
  if (!result.avatar?.id) {
    throw new Error(`数字专家「${template.name}」已创建，但未返回专家标识。`);
  }
  return { name, avatar: result.avatar };
}
