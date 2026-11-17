// Keyboard event taps: programs hooked into an app's key events. A computer-use controller installs
// them on the app it drives, and one left behind can deliver every key a second time. macOS lists
// them through CoreGraphics, which Node can't call, so a short Python script does, with no packages:
// through uv when it is installed, otherwise the system Python.
import { execute } from './process.mjs';

const LIST_TAPS = `
import ctypes, ctypes.util, json, subprocess
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
class Tap(ctypes.Structure):
    _fields_ = [('id', ctypes.c_uint32), ('point', ctypes.c_uint32), ('options', ctypes.c_uint32), ('events', ctypes.c_uint64),
                ('tapper', ctypes.c_int32), ('tapped', ctypes.c_int32), ('enabled', ctypes.c_bool),
                ('minLatency', ctypes.c_float), ('avgLatency', ctypes.c_float), ('maxLatency', ctypes.c_float)]
count = ctypes.c_uint32(0)
cg.CGGetEventTapList(0, None, ctypes.byref(count))
taps = (Tap * count.value)()
cg.CGGetEventTapList(count.value, taps, ctypes.byref(count))
def name(pid):
    return subprocess.run(['ps', '-o', 'comm=', '-p', str(pid)], capture_output=True, text=True).stdout.strip().split('/')[-1] if pid else ''
print(json.dumps([{'tapperPid': t.tapper, 'tapper': name(t.tapper), 'tappedPid': t.tapped, 'active': t.options == 0,
                   'enabled': bool(t.enabled), 'keys': bool(t.events & ((1 << 10) | (1 << 11)))} for t in taps[:count.value]]))
`;

/**
 * Every event tap on this Mac.
 * @param {{ executeCommand?: Function, signal?: AbortSignal }} [options]
 */
export async function listTaps({ executeCommand = execute, signal } = {}) {
  let lastError;
  for (const python of [['uv', 'run', '--no-project', '--quiet', 'python', '-I', '-'], ['/usr/bin/python3', '-I', '-']]) {
    try { return JSON.parse((await executeCommand(python, { input: LIST_TAPS, signal, timeoutMs: 60000 })).stdout.trim()); } catch (error) { lastError = error; }
  }
  throw new Error(`Could not list keyboard taps: ${lastError?.message ?? 'no Python'}`);
}

/** The process id of Claude Desktop's main process, if it is running. */
export async function claudePid({ executeCommand = execute, signal } = {}) {
  const { stdout } = await executeCommand(['ps', '-axo', 'pid=,comm='], { signal, timeoutMs: 10000 });
  const line = stdout.split('\n').find(row => row.trim().endsWith('/Claude.app/Contents/MacOS/Claude'));
  return line ? Number(line.trim().split(/\s+/)[0]) : undefined;
}

/**
 * Active, enabled keyboard taps another program holds on Claude Desktop, which can change or
 * repeat what you type there, minus those present before the run.
 * @param {{ before?: object[], executeCommand?: Function, signal?: AbortSignal }} [options]
 */
export async function claudeKeyTaps({ before = [], executeCommand = execute, signal } = {}) {
  const pid = await claudePid({ executeCommand, signal });
  if (!pid) return [];
  const known = new Set(before.map(tap => `${tap.tapperPid}:${tap.tappedPid}`));
  return (await listTaps({ executeCommand, signal })).filter(tap => tap.tappedPid === pid && tap.active && tap.enabled && tap.keys && !known.has(`${tap.tapperPid}:${tap.tappedPid}`));
}
