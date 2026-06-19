var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
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
var __dirname = path.dirname(fileURLToPath(import.meta.url));
function runStep(script, args) {
    if (args === void 0) { args = []; }
    return new Promise(function (resolve) {
        var proc = spawn('node', __spreadArray([path.join(__dirname, '_etl_scripts', script)], args, true), {
            cwd: __dirname,
            env: __assign({}, process.env),
        });
        var stdout = '';
        var stderr = '';
        proc.stdout.on('data', function (d) { stdout += d.toString(); });
        proc.stderr.on('data', function (d) { stderr += d.toString(); });
        proc.on('close', function (code) { return resolve({ code: code !== null && code !== void 0 ? code : 0, stdout: stdout, stderr: stderr }); });
    });
}
export function etlApiPlugin() {
    return {
        name: 'allmoxy-etl-api',
        apply: 'serve', // dev only — never in production builds
        configureServer: function (server) {
            var _this = this;
            server.middlewares.use('/api/bid-only/toggle', function (req, res) { return __awaiter(_this, void 0, void 0, function () {
                var body;
                var _this = this;
                return __generator(this, function (_a) {
                    if (req.method !== 'POST') {
                        res.statusCode = 405;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                        return [2 /*return*/];
                    }
                    body = '';
                    req.on('data', function (chunk) { body += chunk.toString(); });
                    req.on('end', function () { return __awaiter(_this, void 0, void 0, function () {
                        function emit(line) {
                            log.push(line);
                            // eslint-disable-next-line no-console
                            console.log('[etl-api]', line);
                        }
                        var aid, action, parsed, log, step, _i, _a, script;
                        return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0:
                                    try {
                                        parsed = JSON.parse(body || '{}');
                                        aid = Number(parsed.aid);
                                        action = parsed.action;
                                    }
                                    catch (_c) {
                                        res.statusCode = 400;
                                        res.setHeader('Content-Type', 'application/json');
                                        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
                                        return [2 /*return*/];
                                    }
                                    if (!Number.isFinite(aid) || (action !== 'add' && action !== 'remove')) {
                                        res.statusCode = 400;
                                        res.setHeader('Content-Type', 'application/json');
                                        res.end(JSON.stringify({ ok: false, error: 'Expected { aid: number, action: "add" | "remove" }' }));
                                        return [2 /*return*/];
                                    }
                                    log = [];
                                    emit("\u2192 toggle_bid_only.mjs ".concat(action, " ").concat(aid));
                                    return [4 /*yield*/, runStep('toggle_bid_only.mjs', [action, String(aid)])];
                                case 1:
                                    step = _b.sent();
                                    if (step.code !== 0) {
                                        res.statusCode = 500;
                                        res.setHeader('Content-Type', 'application/json');
                                        res.end(JSON.stringify({ ok: false, error: 'toggle script failed', log: log.concat(step.stderr.split('\n')) }));
                                        return [2 /*return*/];
                                    }
                                    emit('  ✓ toggle done');
                                    _i = 0, _a = ['build_churn_risk_matrix.mjs', 'build_time_to_value.mjs'];
                                    _b.label = 2;
                                case 2:
                                    if (!(_i < _a.length)) return [3 /*break*/, 5];
                                    script = _a[_i];
                                    emit("\u2192 ".concat(script));
                                    return [4 /*yield*/, runStep(script)];
                                case 3:
                                    step = _b.sent();
                                    if (step.code !== 0) {
                                        res.statusCode = 500;
                                        res.setHeader('Content-Type', 'application/json');
                                        res.end(JSON.stringify({ ok: false, error: "".concat(script, " failed"), log: log.concat(step.stderr.split('\n')) }));
                                        return [2 /*return*/];
                                    }
                                    emit("  \u2713 ".concat(script, " done"));
                                    _b.label = 4;
                                case 4:
                                    _i++;
                                    return [3 /*break*/, 2];
                                case 5:
                                    res.statusCode = 200;
                                    res.setHeader('Content-Type', 'application/json');
                                    res.end(JSON.stringify({ ok: true, aid: aid, action: action, log: log }));
                                    return [2 /*return*/];
                            }
                        });
                    }); });
                    return [2 /*return*/];
                });
            }); });
        },
    };
}
