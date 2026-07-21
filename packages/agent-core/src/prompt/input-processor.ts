import type { AgentRuntimeCommand } from "../contracts.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";

/**
 * InputProcessor 的处理输入。
 *
 * 这一层处理的是“外部 runtime command 进入 prompt 流程后的第一道门”。
 * 它不读取 conversation，不装配 context，也不调用模型；这些职责分别属于
 * ConversationStore / ContextAssembler / AgentLoopAdapter。
 */
export type InputProcessorInput = {
  command: AgentRuntimeCommand;
};

/**
 * InputProcessor 输出。
 *
 * - `ready`：输入应该继续进入 TurnRunner 后续流程。
 * - `handled`：输入已经被 lifecycle 或后续本地能力处理完，不进入 agent loop。
 */
export type ProcessedInput =
  | { status: "ready"; command: AgentRuntimeCommand }
  | { status: "handled" };

export type InputProcessorOptions = {
  /** 生命周期执行器；第一版只接入 onInput，后续 prompt template/skill 展开也会挂在这里。 */
  lifecycleRunner?: LifecycleRunner;
};

/**
 * 把外部 AgentRuntimeCommand 处理成 TurnRunner 可以继续编排的输入。
 *
 * 执行流程：
 *
 * ```text
 * AgentRuntimeSession.execute(command)
 *   -> TurnRunner.run(command)
 *   -> InputProcessor.process(command)
 *      -> LifecycleRunner.onInput(command)
 *         -> continue: 保持 command 不变
 *         -> transform: 使用改写后的 command
 *         -> handled: 短路，不进入模型
 *   -> TurnRunner 根据 ProcessedInput 决定下一步
 * ```
 *
 * 第一版只做 lifecycle onInput 归一化。后续 prompt template expansion、
 * skill command expansion 和 input metadata normalize 都应该继续落在这里，
 * 而不是塞回 TurnRunner。
 */
export class InputProcessor {
  constructor(private readonly options: InputProcessorOptions = {}) {}

  async process(input: InputProcessorInput): Promise<ProcessedInput> {
    const inputResult = await this.options.lifecycleRunner?.onInput({
      command: input.command,
    });

    if (inputResult?.action === "handled") {
      return { status: "handled" };
    }

    if (inputResult?.action === "transform") {
      return {
        status: "ready",
        command: inputResult.command,
      };
    }

    return {
      status: "ready",
      command: input.command,
    };
  }
}
