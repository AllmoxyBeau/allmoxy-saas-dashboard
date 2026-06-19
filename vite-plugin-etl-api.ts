/**
 * Vite dev-server plugin that exposes a small admin API for running ETL
 * scripts from the browser. Used by the bid-only toggle on Customer Detail
 * so flipping the switch persists to bid_only_customers.json AND re-runs
 * the downstream builds — instead of only updating localStorage.
 *
 * IMPORTANT: this plugin runs ONLY in dev (`npm run dev`). Production builds
 * on Vercel don't have it — those deployments are static and can't execute
 * Node scripts. That's the right boundary: only the local admin (Beau) ever
 * triggers ETL; CS reps just consume the snapshots.
 *
 * Security: Vite's dev server binds to 127.0.0.1 by default, so only the
 * same machine can hit the endpoint.
 *
 * Endpoints:
 *   POST /api/bid-only/toggle   { aid, action: 'add' | 'remove' }
 *     → spawns toggle_bid_only.mjs + downstream builders
 *     → returns { ok, log } when done
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runStep(script: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [path.join(__dirname, '_etl_scripts', script), ...args], {
      cwd: __dirname,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export function etlApiPlugin(): Plugin {
  return {
    name: 'allmoxy-etl-api',
    apply: 'serve', // dev only — never in production builds
    configureServer(server) {
      server.middlewares.use('/api/bid-only/toggle', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
          let aid: number | undefined;
          let action: 'add' | 'remove' | undefined;
          try {
            const parsed = JSON.parse(body || '{}');
            aid = Number(parsed.aid);
            action = parsed.action;
          } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
            return;
          }
          if (!Number.isFinite(aid) || (action !== 'add' && action !== 'remove')) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'Expected { aid: number, action: "add" | "remove" }' }));
            return;
          }
          const log: string[] = [];
          function emit(line: string) {
            log.push(line);
            // eslint-disable-next-line no-console
            console.log('[etl-api]', line);
          }
          emit(`→ toggle_bid_only.mjs ${action} ${aid}`);
          let step = await runStep('toggle_bid_only.mjs', [action, String(aid)]);
          if (step.code !== 0) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'toggle script failed', log: log.concat(step.stderr.split('\n')) }));
            return;
          }
          emit('  ✓ toggle done');
          // Rebuild the snapshots the matrix-derived pages read from
          for (const script of ['build_churn_risk_matrix.mjs', 'build_time_to_value.mjs']) {
            emit(`→ ${script}`);
            step = await runStep(script);
            if (step.code !== 0) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: `${script} failed`, log: log.concat(step.stderr.split('\n')) }));
              return;
            }
            emit(`  ✓ ${script} done`);
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, aid, action, log }));
        });
      });
    },
  };
}
