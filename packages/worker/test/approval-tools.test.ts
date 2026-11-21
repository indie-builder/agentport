import { describe, expect, it } from 'bun:test';
import { collectApprovalTools, unambiguousDeniedToolNames } from '../src/runs/approval-tools.js';

describe('collectApprovalTools', () => {
  const serverRows = [
    {
      name: 'crm',
      tools: [
        { name: 'delete_contact', enabled: true, approvalMode: 'deny' as const },
        { name: 'create_contact', enabled: true, approvalMode: 'ask' as const },
        { name: 'list_contacts', enabled: true, approvalMode: 'allow' as const },
        { name: 'purge_contacts', enabled: false, approvalMode: 'deny' as const },
      ],
    },
  ];
  const approvalModes = [
    { serverId: 'srv-live', toolName: 'drop_table', approvalMode: 'deny' as const },
    { serverId: 'srv-live', toolName: 'rename_table', approvalMode: 'ask' as const },
    { serverId: 'srv-live', toolName: 'read_table', approvalMode: 'allow' as const },
  ];
  const serverNamesById = new Map([['srv-live', 'warehouse']]);

  it('collects enabled deny tools from server rows and live tools only', () => {
    expect(
      collectApprovalTools(serverRows, approvalModes, serverNamesById, 'deny').map(
        (tool) => `mcp__${tool.server}__${tool.tool}`,
      ),
    ).toEqual(['mcp__crm__delete_contact', 'mcp__warehouse__drop_table']);
  });

  it('keeps ask separate and allows allow tools through', () => {
    expect(collectApprovalTools(serverRows, approvalModes, serverNamesById, 'ask')).toEqual([
      { server: 'crm', tool: 'create_contact' },
      { server: 'warehouse', tool: 'rename_table' },
    ]);
    expect(
      collectApprovalTools(serverRows, approvalModes, serverNamesById, 'deny'),
    ).not.toContainEqual({ server: 'crm', tool: 'list_contacts' });
    expect(
      collectApprovalTools(serverRows, approvalModes, serverNamesById, 'ask'),
    ).not.toContainEqual({ server: 'warehouse', tool: 'read_table' });
  });

  it('skips tools whose server is no longer bound', () => {
    expect(collectApprovalTools(serverRows, approvalModes, new Map(), 'deny')).toEqual([
      { server: 'crm', tool: 'delete_contact' },
    ]);
  });
});

describe('unambiguousDeniedToolNames', () => {
  it('drops deny names shared by servers whose names contain double underscores', () => {
    const collidingRows = [
      {
        name: 'review',
        tools: [{ name: 'crm__read', enabled: true, approvalMode: 'allow' as const }],
      },
    ];
    const collidingModes = [
      { serverId: 'srv-review-crm', toolName: 'read', approvalMode: 'deny' as const },
      { serverId: 'srv-review', toolName: 'delete_all', approvalMode: 'deny' as const },
    ];
    const collidingServerNames = new Map([
      ['srv-review-crm', 'review__crm'],
      ['srv-review', 'review'],
    ]);

    expect(unambiguousDeniedToolNames(collidingRows, collidingModes, collidingServerNames)).toEqual(
      ['mcp__review__delete_all'],
    );
  });
});
