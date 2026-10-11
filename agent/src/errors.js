// Ошибка, текст которой можно показать в админке. Всё остальное уходит на сайт как "internal".
export class AgentError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

export const check = {
  string(value, name, { max = 256, pattern, allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw new AgentError('bad_params', `${name}: ожидается строка`);
    if (!allowEmpty && value.length === 0) throw new AgentError('bad_params', `${name}: пусто`);
    if (value.length > max) throw new AgentError('bad_params', `${name}: длиннее ${max}`);
    if (pattern && !pattern.test(value)) throw new AgentError('bad_params', `${name}: недопустимый формат`);
    return value;
  },
  int(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AgentError('bad_params', `${name}: целое число от ${min} до ${max}`);
    }
    return value;
  },
  // Текст для игрового чата/причины бана: без переводов строк и управляющих символов.
  text(value, name, max = 200) {
    return check.string(value, name, { max }).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  },
};
