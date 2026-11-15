export function measureSession(session) {
  const observations = session.events.filter(event => event.kind === 'observation');
  const actions = session.events.filter(event => event.kind === 'action');
  const invocations = session.agentInvocations;
  const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
  const roleTime = role => Array.isArray(invocations) ? sum(invocations.filter(item => item.role === role), 'durationMs') : null;
  const checks = session.checkResults ?? [];
  return {
    version: 1,
    surface: session.target?.kind === 'fixture' ? 'synthetic' : 'desktop',
    task: { testerStatus: session.status, completionBasis: 'tester self-report; configured checks assessed separately' },
    observations: observations.length,
    actions: {
      total: actions.length,
      byType: Object.fromEntries(['click', 'click_point', 'type', 'press', 'scroll', 'wait'].map(type => [type, actions.filter(event => event.action.type === type).length])),
      uncertain: actions.filter(event => event.outcome === 'uncertain').length,
      pending: actions.filter(event => event.outcome === 'pending').length,
    },
    timing: {
      interactionWallMs: session.finishedAt ? Date.parse(session.finishedAt) - Date.parse(session.startedAt) : null,
      testerModelMs: roleTime('tester'),
      criticModelMs: roleTime('critic'),
      captureDriverMs: sum(observations, 'durationMs'),
      inputDriverMs: sum(actions.filter(event => event.action.type !== 'wait'), 'durationMs'),
      requestedWaitMs: actions.filter(event => event.action.type === 'wait').reduce((total, event) => total + event.action.ms, 0),
      interpretation: 'Driver times include capture/automation overhead. They are not pure application latency. Critic time is outside the interaction wall time.',
    },
    checks: { passed: checks.filter(check => check.status === 'passed').length, failed: checks.filter(check => check.status === 'failed').length, unassessed: checks.filter(check => check.status === 'unassessed').length },
    unmeasured: ['Human annoyance/satisfaction', 'Transient interruptions between captured frames', 'Pure host response latency', 'Optimal-path overhead without a matched baseline'],
  };
}
