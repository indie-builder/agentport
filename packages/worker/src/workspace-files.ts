import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE, type WorkspaceFiles } from '@agentport/core';
import { writeRulesDirectory } from './session-workspace.js';

export async function materializeWorkspace(rootDir: string, files: WorkspaceFiles): Promise<void> {
  const agentsDir = join(rootDir, '.claude', 'agents');
  const skillsDir = join(rootDir, '.claude', 'skills');
  await rm(agentsDir, { recursive: true, force: true });
  await mkdir(agentsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
  await writeFile(join(rootDir, '.mcp.json'), files.mcpJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  await Bun.write(join(rootDir, 'CLAUDE.md'), files.claudeMd);
  for (const subAgent of files.subAgents) {
    await writeFile(join(agentsDir, `${subAgent.slug}.md`), subAgent.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }

  await rm(skillsDir, { recursive: true, force: true });
  for (const skill of files.skills) {
    const target = join(skillsDir, skill.slug);
    await mkdir(target, { mode: WORKSPACE_DIR_MODE, recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
    for (const file of skill.files) {
      const filePath = join(target, file.path);
      await mkdir(join(filePath, '..'), { mode: WORKSPACE_DIR_MODE, recursive: true });
      await writeFile(filePath, file.content, { encoding: 'utf8', mode: WORKSPACE_FILE_MODE });
    }
  }
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
  await writeRulesDirectory(join(rootDir, '.claude', 'rules'), files.rules);
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
          mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
        });
      }
    }
    await chmod(pluginsDir, WORKSPACE_DIR_MODE);
  }
  const settingsPath = join(rootDir, '.claude', 'settings.json');
  await writeFile(settingsPath, files.settingsJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  await chmod(rootDir, WORKSPACE_DIR_MODE);
  await chmod(join(rootDir, '.claude'), WORKSPACE_DIR_MODE);
  await chmod(join(rootDir, '.mcp.json'), WORKSPACE_FILE_MODE);
}
