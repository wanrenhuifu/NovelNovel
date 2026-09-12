/**
 * 文件 IO 封装：文本读写一律走 ctx.fs（受 harness 沙箱与权限策略约束、
 * 与 write/edit 工具共用版本语义与变更通知）。
 *
 * ctx.fs 没有删除与二进制写入能力，因此「删除文件」和「写 PNG 头像」用 node:fs，
 * 路径仍由 ctx.fs.resolve + processPath 得出（解析口径与沙箱一致，且限定在项目目录内）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Context,
  FsDirEntry,
  FsTarget,
  FsWriteIntent,
  SandboxExecutionPolicy,
  SandboxPolicyService,
  ToolRunContext,
} from "./contract";

export interface FsSession {
  /** 会话工作目录：相对路径的解析基准，也是沙箱判定边界 */
  cwd: string;
  signal?: AbortSignal;
  sandboxPolicy?: SandboxExecutionPolicy;
  /**
   * 触发本次调用的工具执行上下文（actor）。
   * 写入后 emit('fs/observed') 带上它，harness 的「先读后写」策略才能把这次写入
   * 记到该会话名下——与首方 write 工具一致；命令等没有 exec 的调用留空即可（策略不记录）。
   */
  actor?: unknown;
}

export class FsOps {
  constructor(private readonly ctx: Context) {}

  /** 由会话 + 信号构造文件会话（命令处理器等没有 exec 的场景也用它） */
  sessionFor(
    session: { readonly header: { readonly cwd?: string } } | undefined,
    signal?: AbortSignal,
  ): FsSession {
    const policy = this.ctx
      .get<SandboxPolicyService>("sandboxPolicy")
      ?.resolve(session ? { session } : {});
    return {
      cwd: session?.header.cwd ?? process.cwd(),
      ...(signal ? { signal } : {}),
      ...(policy ? { sandboxPolicy: policy } : {}),
    };
  }

  /** 由工具执行上下文构造会话（缺 agent 时退化为进程工作目录） */
  sessionOf(exec: ToolRunContext): FsSession {
    return { ...this.sessionFor(exec.agent?.session, exec.signal), actor: exec };
  }

  async resolve(path: string, session: FsSession): Promise<FsTarget> {
    return this.ctx.fs.resolve(path, {
      cwd: session.cwd,
      ...(session.signal ? { signal: session.signal } : {}),
    });
  }

  /** 读文本；文件不存在返回 null（其余错误照常抛出） */
  async readTextOrNull(path: string, session: FsSession): Promise<string | null> {
    const target = await this.resolve(path, session);
    const info = await this.ctx.fs.stat(target, session.signal);
    if (info === undefined) return null;
    if (info.type !== "file") return null;
    return this.ctx.fs.readText(target, session.signal);
  }

  /** 读文本；文件不存在抛错（调用方期望它存在） */
  async readText(path: string, session: FsSession): Promise<string> {
    const text = await this.readTextOrNull(path, session);
    if (text === null) throw new Error(`file not found: ${path}`);
    return text;
  }

  async readJson<T>(path: string, session: FsSession): Promise<T | null> {
    const text = await this.readTextOrNull(path, session);
    if (text === null) return null;
    try {
      // 数据文件是给人手改的（Notepad 等编辑器会写 BOM），解析前先去掉
      return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
    } catch {
      throw new Error(`file is not valid JSON: ${path}`);
    }
  }

  /**
   * 写文本：按当前版本号构造写入意图——已存在则做 stale 校验（文件被外部改动会失败），
   * 不存在则禁止覆盖。这样既满足 fs-local 的「必须先读再覆盖」约束，
   * 又让并发改动不被静默丢弃。
   */
  async writeText(path: string, content: string, session: FsSession): Promise<void> {
    const target = await this.resolve(path, session);
    const info = await this.ctx.fs.stat(target, session.signal);
    const intent: FsWriteIntent =
      info === undefined
        ? { kind: "createIfAbsent" }
        : { kind: "replaceIfVersion", version: info.version };
    const outcome = await this.ctx.fs.writeText(
      target,
      content,
      intent,
      session.signal,
      session.sandboxPolicy,
    );
    // 通知变更流（Web UI 的 workspace 文件变更订阅与「先读后写」策略都依赖它）。
    // actor 传触发本次写入的工具上下文，观察记录才会落在该会话名下（缺省则不记录）。
    this.ctx.emit(
      "fs/observed",
      target,
      { kind: "present", version: outcome.version },
      session.actor,
    );
  }

  async writeJson(path: string, value: unknown, session: FsSession): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`, session);
  }

  /** 列目录；目录不存在返回 []（首次使用时项目目录尚未创建） */
  async listDir(path: string, session: FsSession): Promise<FsDirEntry[]> {
    const target = await this.resolve(path, session);
    const info = await this.ctx.fs.stat(target, session.signal);
    if (info === undefined || info.type !== "directory") return [];
    return this.ctx.fs.listDir(target, session.signal);
  }

  /**
   * 二进制写入与删除走 node:fs（ctx.fs 没有这两种能力），因此**不受沙箱策略约束**。
   * 为避免插件成为绕过沙箱的写/删通道，这里显式要求目标落在会话工作目录内。
   */
  private async assertInsideWorkspace(
    target: FsTarget,
    display: string,
    action: "write" | "delete",
    session: FsSession,
  ): Promise<void> {
    const root = await this.resolve(session.cwd, session);
    if (this.ctx.fs.contains(root, target)) return;
    throw new Error(
      `refusing to ${action} "${display}": it is outside the workspace (${root.displayPath}). ` +
        "Binary writes and deletions use node:fs on purpose (ctx.fs cannot do them) and are therefore " +
        "not fenced by the sandbox, so this plugin keeps them inside the workspace.",
    );
  }

  /** 删除文件（ctx.fs 无删除能力，走 node:fs；路径由 ctx.fs 解析并限定在工作区内） */
  async removeFile(path: string, session: FsSession): Promise<void> {
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "delete", session);
    await rm(this.ctx.fs.processPath(target), { force: true });
  }

  /** 删除目录及其中全部内容 */
  async removeDir(path: string, session: FsSession): Promise<void> {
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "delete", session);
    await rm(this.ctx.fs.processPath(target), { recursive: true, force: true });
  }

  /** 写二进制文件（ctx.fs 只写文本；用于角色卡 PNG 导出） */
  async writeBytes(path: string, bytes: Uint8Array, session: FsSession): Promise<void> {
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "write", session);
    const absolute = this.ctx.fs.processPath(target);
    // ctx.fs 的写入会自动补目录，node:fs 不会，这里显式建目录
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }

  /** 读二进制文件（角色卡 PNG 导入）；不存在返回 null */
  async readBytesOrNull(path: string, session: FsSession): Promise<Uint8Array | null> {
    const target = await this.resolve(path, session);
    const info = await this.ctx.fs.stat(target, session.signal);
    if (info === undefined || info.type !== "file") return null;
    const cap = Math.max((info.size ?? 0) + 4096, 1 << 20);
    return this.ctx.fs.readBytes(target, session.signal, cap);
  }
}
