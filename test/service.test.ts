import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlist, composePath, parseLaunchctlPrint, SERVICE_LABEL, xmlEscape } from '../src/service.ts';

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
    assert.deepEqual(args.slice(0, 5), [
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
