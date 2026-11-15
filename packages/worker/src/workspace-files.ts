import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE, type WorkspaceFiles } from '@agentport/core';
import { writeRulesDirectory } from './session-workspace.js';

export async function materializeWorkspace(rootDir: string, files: WorkspaceFiles): Promise<void> {
  const agentsDir = join(rootDir, '.claude', 'agents');
  const skillsDir = join(rootDir, '.claude', 'skills');
  // 子智能体每次重建：解绑后旧文件不能残留，否则 SDK 仍会发现它。
  await rm(agentsDir, { recursive: true, force: true });
  await mkdir(agentsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
  await writeFile(join(rootDir, '.mcp.json'), files.mcpJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  await writeFile(join(rootDir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  // 主智能体自己的 md 不落盘：放进 .claude/agents/ 会被 SDK 当成可委派子智能体，
  // 形成自我递归。它只用于 API 预览，CLAUDE.md 已承载主智能体上下文。
  for (const subAgent of files.subAgents) {
    await writeFile(join(agentsDir, `${subAgent.slug}.md`), subAgent.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }

  // 技能每次重建：先清掉旧目录，避免已解绑的技能残留。
  await rm(skillsDir, { recursive: true, force: true });
  for (const skill of files.skills) {
    const target = join(skillsDir, skill.slug);
    await mkdir(target, { mode: WORKSPACE_DIR_MODE, recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
    // 支持资源文件（scripts/、references/ 等）；path 已在写入时校验为安全相对路径。
    for (const file of skill.files) {
      const filePath = join(target, file.path);
      await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
      await writeFile(filePath, file.content, { encoding: 'utf8', mode: WORKSPACE_FILE_MODE });
    }
  }
  // 工作流每次重建：先清旧目录，避免解绑/删除的工作流继续被 SDK 发现。
  const workflowsDir = join(rootDir, '.claude', 'workflows');
  await rm(workflowsDir, { recursive: true, force: true });
  if (files.workflows.length > 0) {
    await mkdir(workflowsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const workflow of files.workflows) {
      await writeFile(join(workflowsDir, `${workflow.slug}.js`), workflow.content, {
        encoding: 'utf8',
        mode: WORKSPACE_FILE_MODE,
      });
    }
  }
  // 项目规则每次重建：写到 .claude/rules/<slug>.md，由 project source 随会话加载。
  await writeRulesDirectory(join(rootDir, '.claude', 'rules'), files.rules);
  // 自定义输出风格：写到 .claude/output-styles/<slug>.md；选中者写进 .claude/settings.json。
  const stylesDir = join(rootDir, '.claude', 'output-styles');
  await rm(stylesDir, { recursive: true, force: true });
  if (files.outputStyles.length > 0) {
    await mkdir(stylesDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const style of files.outputStyles) {
      await writeFile(join(stylesDir, `${style.slug}.md`), style.content, {
        encoding: 'utf8',
        mode: WORKSPACE_FILE_MODE,
      });
    }
  }
  const hooksDir = join(rootDir, '.claude', 'hooks');
  await rm(hooksDir, { recursive: true, force: true });
  if (files.hookFiles.length > 0) {
    await mkdir(hooksDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const file of files.hookFiles) {
      const filePath = join(hooksDir, file.path);
      await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
      await writeFile(filePath, file.content, {
        encoding: 'utf8',
        mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
      });
    }
  }
  // 插件每次重建：解绑或撤销授权后旧组件不能残留，否则 SDK 仍会按目录加载。
  const pluginsDir = join(rootDir, '.claude', 'plugins');
  await rm(pluginsDir, { recursive: true, force: true });
  if (files.plugins.length > 0) {
    await mkdir(pluginsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
    for (const plugin of files.plugins) {
      const root = join(pluginsDir, plugin.slug);
      for (const file of plugin.files) {
        const filePath = join(root, file.path);
        await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
        await writeFile(filePath, file.content, {
          encoding: 'utf8',
          // 可执行脚本用 0700：同一模式下既保留 x 位，也只对属主开放。
          mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
        });
      }
    }
    await chmod(pluginsDir, WORKSPACE_DIR_MODE);
  }
  // settings.json 与预览同源（renderWorkspace），outputStyle 写在这里由 project settings 加载。
  // inline settings 与磁盘文件按 key 合并：只覆盖同名 key，未指定的字段仍继承磁盘值。
  const settingsPath = join(rootDir, '.claude', 'settings.json');
  await writeFile(settingsPath, files.settingsJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  // mode 只在创建时生效；已存在的工作区（BullMQ 重试复用）要再 chmod 一次。
  await chmod(rootDir, WORKSPACE_DIR_MODE);
  await chmod(join(rootDir, '.claude'), WORKSPACE_DIR_MODE);
  await chmod(join(rootDir, '.mcp.json'), WORKSPACE_FILE_MODE);
}
