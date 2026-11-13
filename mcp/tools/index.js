// mcp/tools/index.js - Tool registration and schema definitions for StrangersMeetup Control MCP.
import { z } from 'zod';
import {
  getProjectStatus,
  listRoutes,
  inspectPage,
  captureScreenshot,
  auditResponsive,
  auditAuthFlow
} from './website.js';
import {
  readSource,
  getBranchStatus,
  getRecentChanges,
  getChangeHistory
} from './project.js';
import { runSafeTests, AVAILABLE_SUITES } from './testing.js';

export const REGISTERED_TOOL_NAMES = [
  'sm_get_project_status',
  'sm_list_routes',
  'sm_inspect_page',
  'sm_capture_screenshot',
  'sm_audit_responsive',
  'sm_audit_auth_flow',
  'sm_read_source',
  'sm_get_branch_status',
  'sm_get_recent_changes',
  'sm_get_change_history',
  'sm_run_safe_tests'
];

/**
 * Registers all read-only tools onto an McpServer instance.
 */
export function registerAllTools(server) {
  // 1. sm_get_project_status
  server.tool(
    'sm_get_project_status',
    {},
    async () => {
      const res = await getProjectStatus();
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 2. sm_list_routes
  server.tool(
    'sm_list_routes',
    {
      filter: z.enum(['all', 'page', 'api', 'auth', 'organiser', 'admin', 'webhook', 'cron']).optional().describe('Filter routes by category')
    },
    async ({ filter }) => {
      const res = await listRoutes({ filter });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 3. sm_inspect_page
  server.tool(
    'sm_inspect_page',
    {
      path: z.string().describe('Target route path (e.g. /, /events, /signin, /organiser, /admin)'),
      persona: z.enum(['anonymous', 'guest', 'organiser', 'admin', 'staff']).optional().describe('Optional local dev persona to authenticate with')
    },
    async ({ path, persona }) => {
      const res = await inspectPage({ path, persona });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 4. sm_capture_screenshot
  server.tool(
    'sm_capture_screenshot',
    {
      path: z.string().describe('Target public route path (e.g. /, /events, /signin, /faq, /about)'),
      width: z.number().int().optional().describe('Viewport width: 320, 360, 375, 390, 412, 430, 768, or 1280 (default: 1280)'),
      persona: z.enum(['anonymous', 'guest']).optional().describe('Optional public persona (anonymous or guest; admin and organiser personas are prohibited)')
    },
    async ({ path, width, persona }) => {
      const res = await captureScreenshot({ path, width, persona });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: res.status,
              file_name: res.file_name,
              file_path: res.file_path,
              width: res.width,
              height: res.height,
              size_bytes: res.size_bytes
            }, null, 2)
          },
          {
            type: 'image',
            data: res.base64_png,
            mimeType: 'image/png'
          }
        ]
      };
    }
  );

  // 5. sm_audit_responsive
  server.tool(
    'sm_audit_responsive',
    {
      path: z.string().describe('Target route path (e.g. /, /events, /trips)'),
      widths: z.array(z.number().int()).optional().describe('Optional list of viewport widths to test')
    },
    async ({ path, widths }) => {
      const res = await auditResponsive({ path, widths });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 6. sm_audit_auth_flow
  server.tool(
    'sm_audit_auth_flow',
    {},
    async () => {
      const res = await auditAuthFlow();
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 7. sm_read_source
  server.tool(
    'sm_read_source',
    {
      filePath: z.string().describe('Relative path to source file inside repository (e.g. lib/router.js)'),
      startLine: z.number().int().positive().optional().describe('Start line number (1-based, default: 1)'),
      endLine: z.number().int().positive().optional().describe('End line number (max range 300 lines)')
    },
    async ({ filePath, startLine, endLine }) => {
      const res = await readSource({ filePath, startLine, endLine });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 8. sm_get_branch_status
  server.tool(
    'sm_get_branch_status',
    {},
    async () => {
      const res = await getBranchStatus();
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 9. sm_get_recent_changes
  server.tool(
    'sm_get_recent_changes',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Number of recent commits to return (default: 10, max: 50)')
    },
    async ({ limit }) => {
      const res = await getRecentChanges({ limit });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 10. sm_get_change_history
  server.tool(
    'sm_get_change_history',
    {
      filePath: z.string().describe('Relative path to file (e.g. public/css/site.css)'),
      limit: z.number().int().min(1).max(30).optional().describe('Number of commits for this file (default: 10, max: 30)')
    },
    async ({ filePath, limit }) => {
      const res = await getChangeHistory({ filePath, limit });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );

  // 11. sm_run_safe_tests
  server.tool(
    'sm_run_safe_tests',
    {
      suite: z.enum(['unit', 'lint', 'tap_targets', 'responsive_e2e']).describe('Authorized test suite to execute safely')
    },
    async ({ suite }) => {
      const res = await runSafeTests({ suite });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
  );
}
