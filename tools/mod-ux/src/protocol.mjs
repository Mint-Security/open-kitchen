export const VERSION = 1;
export const DEFAULT_APP = 'com.anthropic.claudefordesktop';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, name, max = 12000) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, `${name} must be a nonempty string (max ${max})`);
}

export function validateScenario(value) {
  assert(value && value.version === VERSION, 'Scenario version must be 1');
  text(value.name, 'name', 200);
  text(value.goal, 'goal');
  assert(value.target?.app === DEFAULT_APP, `v1 targets ${DEFAULT_APP}`);
  assert(['background', 'foreground'].includes(value.target.interactionMode ?? 'background'), 'Invalid target interactionMode');
  assert(Array.isArray(value.checks ?? []), 'checks must be an array');
  const ids = new Set();
  for (const check of value.checks ?? []) {
    text(check.id, 'check.id', 100);
    assert(!ids.has(check.id), `Duplicate check: ${check.id}`);
    ids.add(check.id);
    assert(['present', 'absent', 'preserved', 'appeared', 'disappeared'].includes(check.kind), 'Unknown check kind');
    validateSelector(check.selector);
    if (['preserved', 'appeared', 'disappeared'].includes(check.kind)) validateTrigger(check.after);
  }
  const limits = { maxSteps: 20, maxDurationMs: 300000, agentTimeoutMs: 60000, maxObservationAgeMs: 120000, ...value.limits };
  for (const [key, max] of Object.entries({ maxSteps: 200, maxDurationMs: 3600000, agentTimeoutMs: 300000, maxObservationAgeMs: 300000 })) {
    assert(Number.isInteger(limits[key]) && limits[key] > 0 && limits[key] <= max, `Invalid limit ${key}`);
  }
  assert(Array.isArray(value.allowedActions ?? []), 'allowedActions must be an array');
  for (const action of value.allowedActions ?? []) assert(ACTION_TYPES.includes(action), `Unknown allowed action: ${action}`);
  if (value.setup !== undefined) validateSetup(value.setup);
  return { ...value, checks: value.checks ?? [], limits, allowedActions: value.allowedActions ?? ['click', 'type', 'press', 'scroll', 'wait'] };
}

// What `try` prepares before the tester starts: the plugin's store, the session's first message,
// and an unsent draft. `start` and `run` attach to a session someone prepared and ignore it.
function validateSetup(setup) {
  assert(setup && typeof setup === 'object' && !Array.isArray(setup), 'setup must be an object');
  assert(Object.keys(setup).every(key => ['store', 'prompt', 'draft'].includes(key)), 'setup supports store, prompt and draft');
  for (const key of ['prompt', 'draft']) {
    if (setup[key] === undefined) continue;
    text(setup[key], `setup.${key}`, 2000);
    assert(!/[\x00-\x1f\x7f]/.test(setup[key]) && !/\\[ntrb]/.test(setup[key]), `setup.${key} must be one line of literal text`);
  }
  if (setup.store !== undefined) {
    assert(setup.store && typeof setup.store === 'object' && !Array.isArray(setup.store), 'setup.store must be an object');
    assert(JSON.stringify(setup.store).length <= 1024 * 1024, 'setup.store is over 1 MiB');
  }
}

export function validateSelector(selector) {
  assert(selector && typeof selector === 'object' && !Array.isArray(selector), 'A selector object is required');
  const keys = Object.keys(selector);
  assert(keys.length > 0 && keys.every(key => ['role', 'label', 'value'].includes(key)), 'Selectors support role, label and value');
  for (const key of keys) text(selector[key], `selector.${key}`);
}

// A check's trigger: one selector, or a list of selectors any one of which counts (one control under several states' labels).
export function validateTrigger(trigger) {
  if (!Array.isArray(trigger)) return validateSelector(trigger);
  assert(trigger.length > 0 && trigger.length <= 10, 'A trigger list needs 1-10 selectors');
  for (const selector of trigger) validateSelector(selector);
}

export function matches(element, selector) {
  return Object.entries(selector).every(([key, value]) => String(element[key] ?? '') === value);
}

export function matchesTrigger(element, trigger) {
  return (Array.isArray(trigger) ? trigger : [trigger]).some(selector => matches(element, selector));
}

export const ACTION_TYPES = ['click', 'click_point', 'type', 'press', 'scroll', 'wait'];
export function validateAction(action, observation, allowed = ACTION_TYPES) {
  assert(action && allowed.includes(action.type), `Action is not allowed: ${action?.type}`);
  const shapes = { click: ['type', 'element'], click_point: ['type', 'x', 'y'], type: ['type', 'text'], press: ['type', 'key'], scroll: ['type', 'element', 'direction', 'amount'], wait: ['type', 'ms'] };
  assert(Object.keys(action).every(key => shapes[action.type].includes(key)), `Unknown ${action.type} action field`);
  if (['click', 'scroll'].includes(action.type)) {
    text(action.element, 'element', 200);
    assert(observation.elements.some(item => item.id === action.element), 'Element is not in the current observation');
    if (action.type === 'click') assert(observation.elements.find(item => item.id === action.element)?.actionable !== false, 'Element is not actionable; use a screenshot point (click_point) if the scenario allows it');
  }
  if (action.type === 'click_point') for (const key of ['x', 'y']) assert(Number.isFinite(action[key]) && action[key] >= 0 && action[key] <= 1, 'Point coordinates must be normalized 0–1');
  if (action.type === 'type') {
    text(action.text, 'text');
    // Peekaboo type interprets these as key events. Submission must be an explicit press.
    assert(!/[\x00-\x1f\x7f]/.test(action.text) && !/\\[ntrb]/.test(action.text), 'v1 type accepts single-line literal text without control escapes; use explicit key actions');
  }
  if (action.type === 'press') {
    text(action.key, 'key', 100);
    assert(/^(?:(?:cmd|shift|option|ctrl)\+)*(?:[a-z0-9]|return|tab|escape|delete|forwarddelete|up|down|left|right|home|end|space)$/i.test(action.key), 'Unsupported key chord');
  }
  if (action.type === 'scroll') {
    assert(['up', 'down', 'left', 'right'].includes(action.direction), 'Invalid scroll direction');
    assert(Number.isInteger(action.amount) && action.amount >= 1 && action.amount <= 20, 'scroll.amount must be 1–20');
  }
  if (action.type === 'wait') assert(Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= 10000, 'wait.ms must be 0–10000');
  return action;
}

export const actorSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['act', 'done', 'blocked'] },
    reason: { type: 'string' },
    action: {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ACTION_TYPES }, element: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' }, ms: { type: 'integer' },
      }, required: ['type'],
    },
  }, required: ['status', 'reason'],
};

export const criticSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        description: { type: 'string' }, evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
      }, required: ['title', 'severity', 'description', 'evidence'],
    } },
  }, required: ['summary', 'findings'],
};

export function validateDecision(decision, observation, allowed) {
  assert(['act', 'done', 'blocked'].includes(decision?.status), 'Invalid tester status');
  text(decision.reason, 'reason', 4000);
  if (decision.status === 'act') validateAction(decision.action, observation, allowed);
  else assert(decision.action === undefined, 'Terminal decisions must not contain an action');
  return decision;
}

export function validateCritic(result, evidenceIds) {
  text(result?.summary, 'critic.summary', 12000);
  assert(Array.isArray(result.findings) && result.findings.length <= 20, 'Invalid critic findings');
  for (const finding of result.findings) {
    text(finding.title, 'finding.title', 300);
    text(finding.description, 'finding.description');
    assert(['low', 'medium', 'high'].includes(finding.severity), 'Invalid finding severity');
    assert(Array.isArray(finding.evidence) && finding.evidence.length > 0, 'Every finding needs evidence');
    assert(finding.evidence.every(id => evidenceIds.has(id)), 'Critic referenced nonexistent evidence');
  }
  return result;
}
