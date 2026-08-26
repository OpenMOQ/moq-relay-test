/**
 * Auto-generates parameter forms from tool.json parameter schemas.
 */
export class ParamForm {
  constructor() {
    this.params = [];
    this.formEl = null;
  }

  // Resolve grid span class from param type or explicit width hint
  widthClass(param) {
    const w = param.width || this.defaultWidth(param.type);
    return `form-col-${w}`;
  }

  defaultWidth(type) {
    switch (type) {
      case 'number':   return 'sm';   // 1/4
      case 'boolean':  return 'sm';   // 1/4
      case 'select':   return 'sm';   // 1/4
      case 'text':     return 'md';   // 1/2
      case 'url':      return 'md';   // 1/2
      case 'textarea': return 'full'; // full
      default:         return 'md';
    }
  }

  render(params, formEl, tool) {
    this.params = params;
    this.formEl = formEl;
    formEl.innerHTML = '';

    for (const param of params) {
      const group = document.createElement('div');
      group.className = `form-group ${this.widthClass(param)}`;

      const label = document.createElement('label');
      label.setAttribute('for', `param-${param.id}`);
      label.textContent = param.label;
      if (param.required) {
        const req = document.createElement('span');
        req.className = 'required';
        req.textContent = ' *';
        label.appendChild(req);
      }
      group.appendChild(label);

      let input;
      switch (param.type) {
        case 'select':
          input = document.createElement('select');
          for (const opt of param.options || []) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === String(param.default)) option.selected = true;
            input.appendChild(option);
          }
          break;

        case 'boolean':
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = param.default === true;
          group.classList.add('form-group-checkbox');
          break;

        case 'textarea':
          input = document.createElement('textarea');
          input.rows = 4;
          if (param.default !== undefined) input.value = param.default;
          break;

        case 'number':
          input = document.createElement('input');
          input.type = 'number';
          if (param.min !== undefined) input.min = param.min;
          if (param.max !== undefined) input.max = param.max;
          if (param.step !== undefined) input.step = param.step;
          if (param.default !== undefined) input.value = param.default;
          break;

        default: // text, url
          input = document.createElement('input');
          input.type = 'text';
          if (param.default !== undefined) input.value = param.default;
          if (param.placeholder) input.placeholder = param.placeholder;
          break;
      }

      input.id = `param-${param.id}`;
      input.name = param.id;
      if (param.required && param.type !== 'boolean') input.required = true;

      group.appendChild(input);

      if (param.description) {
        const hint = document.createElement('small');
        hint.className = 'param-hint';
        hint.textContent = param.description;
        group.appendChild(hint);
      }

      if (param.id === 'relay_url' && tool?.forceUrlScheme) {
        const notice = document.createElement('small');
        notice.className = 'param-hint param-hint-notice';
        notice.textContent = `This tool only supports ${tool.forceUrlScheme}:// — the URL will be normalized automatically.`;
        group.appendChild(notice);
      }

      formEl.appendChild(group);
    }
  }

  getValues() {
    if (!this.formEl) return null;

    // Use native form validation
    if (!this.formEl.reportValidity()) return null;

    const values = {};
    for (const param of this.params) {
      const el = document.getElementById(`param-${param.id}`);
      if (!el) continue;
      if (param.type === 'boolean') {
        values[param.id] = el.checked;
      } else if (param.type === 'number') {
        values[param.id] = el.value === '' ? undefined : Number(el.value);
      } else {
        values[param.id] = el.value;
      }
    }
    return values;
  }
}
