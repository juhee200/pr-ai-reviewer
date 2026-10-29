import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlist,
  composePath,
  parseLaunchctlPrint,
  parseProgramArguments,
  scriptPathFromArguments,
  SERVICE_LABEL,
  xmlEscape,
} from '../src/service.ts';

describe('parseProgramArguments', () => {
  it('buildPlist로 만든 실행 인자를 이스케이프 전 값으로 되돌린다', () => {
    const spec = {
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/Applications/PR AI Reviewer.app/Contents/Resources/cli/dist/cli.js',
      args: ['run', '--config', `/Users/a&b/<c>"d'.json`],
      pathEnv: '/usr/bin',
      logFile: '/tmp/agent.log',
    };
    const args = parseProgramArguments(buildPlist(spec));
    assert.deepEqual(args.slice(3), [spec.nodePath, spec.scriptPath, ...spec.args]);
    assert.equal(scriptPathFromArguments(args), spec.scriptPath);
    assert.deepEqual(parseProgramArguments(''), []);
  });

  it('셸 검사를 붙이기 전 형식에서도 CLI 경로를 찾는다', () => {
    assert.equal(scriptPathFromArguments(['/opt/homebrew/bin/node', '/x/dist/cli.js', 'run']), '/x/dist/cli.js');
    assert.equal(scriptPathFromArguments([]), null);
  });
});

describe('service plist', () => {
  it('실행 인자를 배열 그대로 넣고 문자열을 XML 이스케이프한다', () => {
    const plist = buildPlist({
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/lib/node_modules/pr-ai-reviewer/dist/cli.js',
      args: ['run', '--post', '--config', '/Users/a&b/<cfg>.json'],
      pathEnv: '/Users/u/.local/bin:/usr/bin',
      logFile: '/Users/u/Library/Logs/pr-ai-reviewer/agent.log',
    });
    assert.ok(plist.includes(`<string>${SERVICE_LABEL}</string>`));
    const args = [...plist.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map((match) => match[1]);
    // 셸 검사 문자열에는 경로가 들어가지 않고, 경로는 뒤따르는 인자로만 넘긴다.
    assert.deepEqual(args.slice(0, 3), ['/bin/sh', '-c', '[ -f &quot;$1&quot; ] || exit 0; exec &quot;$0&quot; &quot;$@&quot;']);
    assert.deepEqual(args.slice(3, 8), [
      '/opt/homebrew/bin/node',
      '/lib/node_modules/pr-ai-reviewer/dist/cli.js',
      'run',
      '--post',
      '--config',
    ]);
    assert.ok(plist.includes('/Users/a&amp;b/&lt;cfg&gt;.json'));
    assert.ok(plist.includes('<key>SuccessfulExit</key>\n    <false/>'));
    assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'));
    assert.equal(xmlEscape(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });

  it('도구 경로를 앞에 두고 중복과 상대 경로를 뺀다', () => {
    const path = composePath(['/Users/u/.local/bin', '/opt/homebrew/bin'], '/opt/homebrew/bin:relative:/usr/bin');
    assert.deepEqual(path.split(':'), ['/Users/u/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('launchctl print 출력에서 상태를 읽는다', () => {
    const status = parseLaunchctlPrint('gui/501/x = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n}');
    assert.deepEqual(status, { state: 'running', pid: 4242, lastExitCode: '(never exited)' });
  });
});
