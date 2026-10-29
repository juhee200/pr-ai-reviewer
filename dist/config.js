import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const XDG_CONFIG = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
const XDG_CACHE = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
const XDG_STATE = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
export const DEFAULT_CONFIG = {
    repos: [],
    pollIntervalSec: 60,
    debounceSec: 90,
    includeDrafts: true,
    engine: 'claude',
    model: null,
    maxBudgetUsd: null,
    timeoutSec: 900,
    maxDiffLines: 3000,
    dryRun: true,
    maxFailures: 3,
    cacheDir: join(XDG_CACHE, 'pr-ai-reviewer'),
    stateDir: join(XDG_STATE, 'pr-ai-reviewer'),
    claudeSettingSources: 'project',
};
/** PR_AI_REVIEWER_CONFIG가 있으면 그 경로를 쓴다. 메뉴바 앱도 이 값을 CLI에 그대로 넘긴다. */
export function defaultConfigPath() {
    const override = process.env['PR_AI_REVIEWER_CONFIG'];
    return override ? expandHome(override) : join(XDG_CONFIG, 'pr-ai-reviewer', 'config.json');
}
// GitHub 소유자·저장소 이름에 쓰이는 문자만 허용한다. 이 값은 캐시 경로와 gh 인자에 쓰인다.
// 소유자는 하이픈으로 시작할 수 없고, 저장소는 .github처럼 점으로 시작할 수 있다.
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
export function validateRepo(value) {
    if (!REPO_PATTERN.test(value) || value.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error(`저장소 이름 형식이 올바르지 않습니다: "${value}" (예: owner/name)`);
    }
    return value;
}
// 모델 이름은 CLI 인자로 넘어가므로 옵션처럼 보이는 값(-로 시작)을 막는다.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*$/;
export function validateModel(value) {
    if (!MODEL_PATTERN.test(value))
        throw new Error(`모델 이름 형식이 올바르지 않습니다: "${value}"`);
    return value;
}
export function validatePrNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`PR 번호 형식이 올바르지 않습니다: "${value}"`);
    }
    return number;
}
export function expandHome(path) {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}
export function parseConfig(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('설정 파일은 JSON 객체여야 합니다.');
    }
    const input = raw;
    const config = { ...DEFAULT_CONFIG };
    if (input['repos'] !== undefined) {
        if (!Array.isArray(input['repos']) || !input['repos'].every((repo) => typeof repo === 'string')) {
            throw new Error('repos는 문자열 배열이어야 합니다.');
        }
        config.repos = [...new Set(input['repos'].map((repo) => validateRepo(repo)))];
    }
    config.pollIntervalSec = readInt(input, 'pollIntervalSec', 15, 3600);
    config.debounceSec = readInt(input, 'debounceSec', 0, 3600);
    config.timeoutSec = readInt(input, 'timeoutSec', 60, 7200);
    config.maxDiffLines = readInt(input, 'maxDiffLines', 100, 100_000);
    config.maxFailures = readInt(input, 'maxFailures', 1, 20);
    config.includeDrafts = readBoolean(input, 'includeDrafts');
    config.dryRun = readBoolean(input, 'dryRun');
    if (input['engine'] !== undefined) {
        if (input['engine'] !== 'claude' && input['engine'] !== 'codex') {
            throw new Error('engine은 "claude" 또는 "codex"여야 합니다.');
        }
        config.engine = input['engine'];
    }
    if (input['model'] !== undefined) {
        if (input['model'] !== null && (typeof input['model'] !== 'string' || !MODEL_PATTERN.test(input['model']))) {
            throw new Error('model은 영문·숫자·.-_:/@[] 로 된 이름 또는 null이어야 합니다.');
        }
        config.model = input['model'];
    }
    if (input['maxBudgetUsd'] !== undefined) {
        const budget = input['maxBudgetUsd'];
        if (budget !== null && (typeof budget !== 'number' || !(budget > 0))) {
            throw new Error('maxBudgetUsd는 0보다 큰 숫자 또는 null이어야 합니다.');
        }
        config.maxBudgetUsd = budget;
    }
    for (const key of ['cacheDir', 'stateDir', 'claudeSettingSources']) {
        const value = input[key];
        if (value === undefined)
            continue;
        if (typeof value !== 'string' || value.trim() === '')
            throw new Error(`${key}는 비어 있지 않은 문자열이어야 합니다.`);
        if (key === 'claudeSettingSources' && !/^[a-z]+(,[a-z]+)*$/.test(value)) {
            throw new Error('claudeSettingSources는 user, project, local을 쉼표로 이은 값이어야 합니다.');
        }
        config[key] = key === 'claudeSettingSources' ? value : expandHome(value);
    }
    return config;
    function readInt(source, key, min, max) {
        const value = source[key];
        if (value === undefined)
            return DEFAULT_CONFIG[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${key}는 ${min}~${max} 사이의 정수여야 합니다.`);
        }
        return value;
    }
    function readBoolean(source, key) {
        const value = source[key];
        if (value === undefined)
            return DEFAULT_CONFIG[key];
        if (typeof value !== 'boolean')
            throw new Error(`${key}는 true 또는 false여야 합니다.`);
        return value;
    }
}
export async function loadConfig(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`설정 파일이 없습니다: ${path}\n먼저 \`pr-ai-reviewer init\`을 실행하세요.`);
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(`설정 파일이 올바른 JSON이 아닙니다: ${path}`);
    }
    return parseConfig(parsed);
}
/** 설정 파일의 원본 객체를 읽는다. 파일이 없으면 null. */
export async function readRawConfig(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`설정 파일은 JSON 객체여야 합니다: ${path}`);
    return parsed;
}
/**
 * 메뉴바 앱이 보낸 변경분을 기존 설정에 합친다. 알려진 키만 받고, 합친 결과가 검증을 통과해야 한다.
 * 저장할 원본 객체와 검증된 설정을 함께 돌려준다.
 */
export function mergeConfigPatch(raw, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
        throw new Error('설정 변경값은 JSON 객체여야 합니다.');
    const allowed = new Set(Object.keys(DEFAULT_CONFIG));
    const unknownKeys = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unknownKeys.length > 0)
        throw new Error(`알 수 없는 설정 키입니다: ${unknownKeys.join(', ')}`);
    const merged = { ...(raw ?? {}), ...patch };
    return { raw: merged, config: parseConfig(merged) };
}
export async function saveRawConfig(path, raw) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    await rename(temp, path);
}
/** 설정 파일이 없을 때만 기본값으로 만든다. 이미 있으면 덮어쓰지 않고 false를 돌려준다. */
export async function writeDefaultConfig(path) {
    await mkdir(dirname(path), { recursive: true });
    const { cacheDir, stateDir, ...rest } = DEFAULT_CONFIG;
    const template = { ...rest, repos: ['owner/name'] };
    try {
        await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
        return true;
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return false;
        throw error;
    }
}
