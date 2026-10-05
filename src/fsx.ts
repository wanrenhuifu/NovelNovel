/**
 * 文件 IO 封装：文本读写一律走 ctx.fs（受 harness 沙箱与权限策略约束、
 * 与 write/edit 工具共用版本语义与变更通知）。
 *
 * ctx.fs 没有删除与二进制写入能力，因此「删除文件」和「写 PNG 头像」用 node:fs，
 * 路径仍由 ctx.fs.resolve + processPath 得出（解析口径与沙箱一致，且限定在项目目录内）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type {
  Context,
  FsDirEntry,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  SandboxExecutionPolicy,
  SandboxPolicyService,
  ToolRunContext,
} from "./contract";

/**
 * realpath，失败返回 undefined。
 *
 * 失败是**正常情况**：目标可能还不存在（新导出文件）、路径可能不可访问。
 * 调用方按「取不到就继续往上找祖先」处理，而不是把它当成错误。
 */
function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

export interface FsSession {
  /** 会话工作目录：相对路径的解析基准，也是沙箱判定边界 */
  cwd: string;
  /**
   * cwd 是**兜底**来的（调用上下文里没有 `agent.session.header.cwd`）。
   *
   * 这种会话只能用来读（读错目录只是读到空），**写入一律拒绝**：否则数据会静默落进
   * `process.cwd()`——桌面端就是应用安装目录，而不是用户的工作区；那个目录也不在面板
   * 白名单里，用户既看不到也选不中，等于投错了笔记本还不报错。
   */
  ephemeral?: boolean;
  signal?: AbortSignal;
  sandboxPolicy?: SandboxExecutionPolicy;
  /**
   * 触发本次调用的工具执行上下文（actor）。
   * 写入后 emit('fs/observed') 带上它，harness 的「先读后写」策略才能把这次写入
   * 记到该会话名下——与首方 write 工具一致；命令等没有 exec 的调用留空即可（策略不记录）。
   */
  actor?: unknown;
}

/**
 * 写入的 CAS 基准：读文件时拿到的版本。
 * `existed: false` 表示读的时候文件还不存在（此时写入必须用 createIfAbsent，
 * 否则会把别人刚建出来的文件覆盖掉）。
 */
export interface VersionBasis {
  readonly version?: FsVersion;
  readonly existed: boolean;
}

/** 检出「读-改-写」窗口内被别人改过：fs-local 的 FS_STALE_VERSION（或插件自己重抛的同义错误） */
export function isStaleVersion(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "FS_STALE_VERSION" || code === "NN_STALE_VERSION";
}

/**
 * 「先读后改」的重试包装：CAS 冲突时重新读取再试。
 * 只对 stale 错误重试——其余错误（权限、沙箱拒绝、JSON 坏了）直接上抛。
 * 重试耗尽后抛一个带 code 的错误，让上层把它翻成「请重新读取再写」的模型可读文案。
 */
export async function withStaleRetry<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isStaleVersion(error) || attempt >= attempts) {
        if (isStaleVersion(error)) {
          throw Object.assign(
            new Error(
              "this file was modified by another session while writing — re-read it and retry",
            ),
            { code: "NN_STALE_VERSION", cause: error },
          );
        }
        throw error;
      }
    }
  }
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
    const cwd = session?.header.cwd;
    // 判**空值**而不是 undefined：`dsh-tools` 在 exec 缺 agent 时会自己合成一个
    // `{ header: { cwd: "" } }`，空串同样是"没有工作区"，只判 undefined 会让它溜过去。
    const hasCwd = typeof cwd === "string" && cwd.trim() !== "";
    return {
      cwd: hasCwd ? cwd : process.cwd(),
      ...(hasCwd ? {} : { ephemeral: true }),
      ...(signal ? { signal } : {}),
      ...(policy ? { sandboxPolicy: policy } : {}),
    };
  }

  /** 由工具执行上下文构造会话 */
  sessionOf(exec: ToolRunContext): FsSession {
    return { ...this.sessionFor(exec.agent?.session, exec.signal), actor: exec };
  }

  /**
   * 拒绝在"没有真实工作目录"的会话里做任何写入。
   *
   * 这类会话的 cwd 是 `process.cwd()` 兜底来的，而桌面端的进程工作目录是**应用安装目录**：
   * 写入会静默落进那里，用户的工作区里什么都没有，且那个目录不在 Web 面板的白名单里
   * （用户既看不到也选不中）。数据落错地方比直接报错糟得多，所以这里 fail fast。
   * 触发条件：工具执行上下文里缺 `agent.session`，或命令处理器拿不到会话。
   */
  private assertWritable(session: FsSession): void {
    if (session.ephemeral !== true) return;
    throw new Error(
      "refusing to write: this call has no session workspace, so the data would land in the " +
        `process working directory (${session.cwd}) instead of the user's workspace. ` +
        "Run the tool from a session (its cwd is the workspace root), or pass an explicit project path.",
    );
  }

  async resolve(path: string, session: FsSession): Promise<FsTarget> {
    return this.ctx.fs.resolve(path, {
      cwd: session.cwd,
      ...(session.signal ? { signal: session.signal } : {}),
    });
  }

  /** 读文本；文件不存在返回 null（其余错误照常抛出） */
  async readTextOrNull(path: string, session: FsSession): Promise<string | null> {
    const text = await this.readTextVersioned(path, session);
    return text === null ? null : text.text;
  }

  /**
   * 读文本 + 版本，用于「先读后改」：把返回的 `version` 传给 writeText 做 CAS 基准，
   * 读取与本写入之间被别处改过就会失败（而不是静默覆盖）。
   * 一次 stat + 一次 readText——版本取自 stat，与 fs-local 的 replaceIfVersion 口径一致。
   */
  async readTextVersioned(
    path: string,
    session: FsSession,
  ): Promise<{ text: string; version: FsVersion; existed: boolean } | null> {
    const target = await this.resolve(path, session);
    const info = await this.ctx.fs.stat(target, session.signal);
    if (info === undefined) return null;
    if (info.type !== "file") return null;
    return {
      text: await this.ctx.fs.readText(target, session.signal),
      version: info.version,
      existed: true,
    };
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
   * 读 JSON，但**损坏时不抛错**而是返回 `error`。
   *
   * 给「一个坏文件不该让整个入口失效」的场景用（角色卡列表、lorebook、presets）：
   * 调用方可以跳过它、照常返回其余数据，并把原因报给用户/模型。
   * 反过来，**决定写入的读**必须继续用 readJson —— 静默当空值会把坏文件覆盖掉。
   */
  async readJsonOrDiagnose<T>(
    path: string,
    session: FsSession,
  ): Promise<{ value: T | null; error?: string; basis: VersionBasis }> {
    const read = await this.readTextVersioned(path, session);
    if (read === null) return { value: null, basis: { existed: false } };
    const basis: VersionBasis = { existed: true, version: read.version };
    try {
      return { value: JSON.parse(read.text.replace(/^\uFEFF/, "")) as T, basis };
    } catch {
      return { value: null, error: `file is not valid JSON: ${path}`, basis };
    }
  }

  /**
   * 写文本。
   *
   * `expected` 给了就用它当 CAS 基准（调用方「读到什么就改什么」），没给才按当前版本号
   * 现场构造意图。这个区别是**并发安全的关键**：现场取版本时，读-改-写窗口内的并发改动
   * 会因为「基准总是最新的」而被静默覆盖；传真值才会在冲突时失败（fail-fast）。
   *
   * `overwrite: false` 用于「产出物」类写入（导出文件）：目标已存在就让写入**失败**，
   * 而不是无声抹掉用户可能已经改过的导出件。走 `createIfAbsent` 的语义天然满足
   * fs-local 的「必须先读再覆盖」约束（它本来就是"禁止覆盖"）。
   */
  async writeText(
    path: string,
    content: string,
    session: FsSession,
    expected?: VersionBasis,
    overwrite = true,
  ): Promise<void> {
    this.assertWritable(session);
    const target = await this.resolve(path, session);
    let intent: FsWriteIntent;
    if (!overwrite) {
      intent = { kind: "createIfAbsent" };
    } else if (expected !== undefined) {
      intent =
        expected.existed && expected.version !== undefined
          ? { kind: "replaceIfVersion", version: expected.version }
          : { kind: "createIfAbsent" };
    } else {
      const info = await this.ctx.fs.stat(target, session.signal);
      intent =
        info === undefined
          ? { kind: "createIfAbsent" }
          : { kind: "replaceIfVersion", version: info.version };
    }
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

  async writeJson(
    path: string,
    value: unknown,
    session: FsSession,
    expected?: VersionBasis,
    overwrite = true,
  ): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`, session, expected, overwrite);
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
   *
   * **必须解析符号链接**：`ctx.fs.contains` 是纯字符串判定（真品 fs-local 用的是
   * `relative(processPath(parent), processPath(child))`，不做 realpath）。因此工作区内一个
   * 指向外面的链接/junction，会让字符串判定认为"在里面"，而 node:fs 的写入/删除**跟随链接**
   * 落到工作区外——那正是整个插件唯一的越界写/删通道。
   * 所以这里对**父目录**做 realpath 再判一次：父目录是最深的存在祖先（文件可能还不存在），
   * 只有它的真实位置仍在工作区内才放行。
   */
  private async assertInsideWorkspace(
    target: FsTarget,
    display: string,
    action: "write" | "delete",
    session: FsSession,
  ): Promise<void> {
    const root = await this.resolve(session.cwd, session);
    const inside =
      this.ctx.fs.contains(root, target) &&
      (await this.realParentInsideWorkspace(this.ctx.fs.processPath(root), target));
    if (inside) return;
    throw new Error(
      `refusing to ${action} "${display}": it resolves outside the workspace (${root.displayPath}) ` +
        "(either the path escapes, or a symlink/junction along it points outside). " +
        "Binary writes and deletions use node:fs on purpose (ctx.fs cannot do them) and are therefore " +
        "not fenced by the sandbox, so this plugin keeps them inside the workspace.",
    );
  }

  /**
   * 目标的最深存在祖先（realpath 后）是否仍在工作区内。
   *
   * 逐级向上找工作区内的第一个真实存在的祖先：命中即用它做 realpath 判定；
   * 一直找不到（父目录整条都不存在）时放行——那种情况下没有链接可跟随。
   */
  private async realParentInsideWorkspace(rootHostPath: string, target: FsTarget): Promise<boolean> {
    const realRoot = safeRealpath(rootHostPath);
    if (realRoot === undefined) return true; // 连工作区都解析不了，交给上层的 contains 结论

    let dir = dirname(this.ctx.fs.processPath(target));
    for (;;) {
      const real = safeRealpath(dir);
      if (real !== undefined) {
        const rel = relative(realRoot, real);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      }
      const parent = dirname(dir);
      if (parent === dir) return true; // 到根都没有存在的祖先
      dir = parent;
    }
  }

  /** 删除文件（ctx.fs 无删除能力，走 node:fs；路径由 ctx.fs 解析并限定在工作区内） */
  async removeFile(path: string, session: FsSession): Promise<void> {
    this.assertWritable(session);
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "delete", session);
    await rm(this.ctx.fs.processPath(target), { force: true });
  }

  /** 删除目录及其中全部内容 */
  async removeDir(path: string, session: FsSession): Promise<void> {
    this.assertWritable(session);
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "delete", session);
    await rm(this.ctx.fs.processPath(target), { recursive: true, force: true });
  }

  /**
   * 写二进制文件（ctx.fs 只写文本；角色卡头像与 PNG 导出走这里）。
   *
   * 这条路径是 node:fs，**没有版本语义**，所以自己做两道闸：
   *   1. 必须在工作区内（assertInsideWorkspace）；
   *   2. 默认**不覆盖已存在的文件**——`out_path` 是 agent 可控参数，没有这道闸时
   *      `novel_character action=export out_path=…/chapters/index.json` 会用 PNG 字节
   *      静默覆盖任意工作区文件（数据文件甚至源码）。要覆盖旧导出必须显式传 overwrite。
   * 写完补 emit('fs/observed')，让变更流与「先读后写」策略看得见这次写入。
   */
  async writeBytes(
    path: string,
    bytes: Uint8Array,
    session: FsSession,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    this.assertWritable(session);
    const target = await this.resolve(path, session);
    await this.assertInsideWorkspace(target, target.displayPath, "write", session);
    const info = await this.ctx.fs.stat(target, session.signal);
    if (info !== undefined && options.overwrite !== true) {
      throw new Error(
        `refusing to overwrite the existing file "${target.displayPath}" with binary data. ` +
          "Pick another path, or pass overwrite=true if replacing that file is really intended.",
      );
    }
    const absolute = this.ctx.fs.processPath(target);
    // ctx.fs 的写入会自动补目录，node:fs 不会，这里显式建目录
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    const written = await this.ctx.fs.stat(target, session.signal);
    if (written !== undefined) {
      this.ctx.emit(
        "fs/observed",
        target,
        { kind: "present", version: written.version },
        session.actor,
      );
    }
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
