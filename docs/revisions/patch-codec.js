export const HEAD = 'icl_block.head.2.weight';
export const BASE_FINGERPRINT = '61f6c28d0d22fc78c29071882bde8dcfa7dc8318476e20be0ee2c1d955180232';
const FORMAT = 'agm.dnp.codepatch/1';
const WIDTH = 1024;
const GROUP = 64;
const ROWS = 3;
function checkHead(head) {
    if (head?.fingerprint !== BASE_FINGERPRINT ||
        head.tensor !== HEAD ||
        head.groupSize !== GROUP ||
        head.codes?.length !== ROWS * WIDTH ||
        head.scales?.length !== (ROWS * WIDTH) / GROUP) {
        throw new Error('The released W4 action-head data is required.');
    }
}
function validateOps(ops, head, allowBaseline = false) {
    checkHead(head);
    if (!Array.isArray(ops) || (!allowBaseline && ops.length === 0) || ops.length > ROWS * WIDTH) {
        throw new Error('A nonempty native patch can contain at most 3,072 unique action-head edits.');
    }
    const seen = new Set();
    return Array.from(ops, (op) => {
        if (!Array.isArray(op) || op.length !== 4)
            throw new Error('Expected [row, column, expected, replacement].');
        const [row, column, oldCode, newCode] = op;
        if (![row, column, oldCode, newCode].every(Number.isSafeInteger))
            throw new Error('Patch coordinates and codes must be integers.');
        if (row < 0 || row >= ROWS || column < 0 || column >= WIDTH)
            throw new Error('Browser edits require action rows 0–2 and channels 0–1023.');
        if (oldCode < -7 || oldCode > 7 || newCode < -7 || newCode > 7 || oldCode === newCode) {
            throw new Error('Expected distinct signed W4 codes in the range −7 to +7.');
        }
        const index = row * WIDTH + column;
        if (seen.has(index))
            throw new Error('Duplicate edit at [' + row + ', ' + column + '].');
        if (head.codes[index] !== oldCode)
            throw new Error('Stale expected code at [' + row + ', ' + column + '].');
        seen.add(index);
        return [row, column, oldCode, newCode];
    });
}
function explanation(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error('A nonempty ' + field + ' is required.');
    return value;
}
/** Return a JSON-compatible native document based on the immutable parent, never a previous proposal. */
export function makeHeadPatch(ops, hypothesis, prediction, head) {
    const valid = validateOps(ops, head);
    return {
        format: FORMAT,
        base_sha256: BASE_FINGERPRINT,
        hypothesis: explanation(hypothesis, 'hypothesis'),
        prediction: explanation(prediction, 'prediction'),
        ops: valid.map((op) => [HEAD, ...op]),
    };
}
/** Validate the entire native document before exposing a detached replacement proposal to a caller. */
export function parseHeadPatch(valueOrJsonText, head) {
    const doc = (typeof valueOrJsonText === 'string' ? JSON.parse(valueOrJsonText) : valueOrJsonText);
    if (doc?.format !== FORMAT)
        throw new Error('Expected a native agm.dnp.codepatch/1 document.');
    if (doc.base_sha256 !== BASE_FINGERPRINT)
        throw new Error('Wrong parent fingerprint. Import a proposal against the released W4 baseline.');
    if (!Array.isArray(doc.ops) || doc.ops.length > ROWS * WIDTH)
        throw new Error('Invalid native operations array.');
    const ops = doc.ops.map((op) => {
        if (!Array.isArray(op) || op.length !== 5 || op[0] !== HEAD) {
            throw new Error('The browser supports only five-field operations on ' + HEAD + '.');
        }
        return op.slice(1);
    });
    const patch = makeHeadPatch(ops, doc.hypothesis, doc.prediction, head);
    return { patch, ops: patch.ops.map((op) => op.slice(1)) };
}
function argmax(values) {
    let best = 0;
    for (let i = 1; i < values.length; ++i)
        if (values[i] > values[best])
            best = i;
    return best;
}
/** Real-valued prediction on a saved native W4 activation. No scoring or episode state is involved. */
export function probeHead(ops, head, record) {
    const valid = validateOps(ops, head, true);
    if (record?.fingerprint !== BASE_FINGERPRINT ||
        !Array.isArray(record.baselineLogits) ||
        record.baselineLogits.length !== ROWS ||
        !record.baselineLogits.every(Number.isFinite) ||
        !Array.isArray(record.hidden) ||
        record.hidden.length !== WIDTH)
        throw new Error('Invalid frozen native activation record.');
    const delta = [0, 0, 0];
    for (const [row, col, before, after] of valid) {
        const scale = head.scales[row * (WIDTH / GROUP) + Math.floor(col / GROUP)];
        const activation = record.hidden[col];
        if (!Number.isFinite(activation) || !Number.isFinite(scale) || scale < 0)
            throw new Error('Invalid activation or group scale.');
        delta[row] += (after - before) * scale * activation;
    }
    const baselineLogits = record.baselineLogits.slice();
    const logits = baselineLogits.map((value, row) => value + delta[row]);
    return { baselineLogits, logits, delta, baselineAction: argmax(baselineLogits), action: argmax(logits) };
}
