import { redirect } from "next/navigation";

/** 已并入「模型与网关 / 调用凭证」。旧地址保留兜底。 */
export default function SessionGrantsPage() {
  redirect("/admin/gateway?section=credentials&credential=grants");
}
