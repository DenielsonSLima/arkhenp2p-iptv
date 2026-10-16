// Shared audio controller; only the settings view lives in the system shell.
export const AUDIO_CHOICES = [
  {mode:'original', label:'Original', description:'Mantém o áudio enviado pelo canal, sem ajuste automático.'},
  {mode:'balanced', label:'Equilibrado', description:'Suaviza picos e diferenças de volume para assistir no dia a dia.'},
  {mode:'night', label:'Noturno', description:'Contém os picos com mais intensidade para assistir em volume baixo.'}
];

export function audioStatusMessage(status = {}, preferences = {}) {
  const mode = preferences.mode ?? status.mode;
  if (status.state === 'unsupported') return 'Proteção automática indisponível neste navegador. O volume por canal continua disponível quando suportado.';
  if (status.state === 'error' || status.state === 'bypassed') return 'O ajuste não pôde ser aplicado a esta reprodução. O áudio original será mantido.';
  if (status.state === 'suspended') return mode === 'original'
    ? 'O áudio aguarda uma interação. Inicie ou retome o vídeo para ouvir o som original.'
    : 'A preferência está salva. Ao iniciar ou retomar o vídeo, o ajuste será aplicado quando disponível.';
  if (mode === 'original') return 'Áudio original selecionado. O volume continua sob seu controle no reprodutor.';
  if (status.state === 'active') return mode === 'night' ? 'Modo Noturno ativo nesta reprodução.' : 'Modo Equilibrado ativo nesta reprodução.';
  return 'A preferência fica salva neste aparelho e será aplicada durante a reprodução, quando disponível.';
}

function node(tag, className, text) {
  const element = document.createElement(tag);element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Live settings update in place so keyboard focus survives engine changes. */
export function renderAudioPreferences(container, {controller, toast} = {}) {
  const section = node('section', 'settings-audio');
  section.append(node('h3', '', 'Mais conforto ao trocar de canal'), node('p', 'settings-note', 'Escolha como tratar as diferenças de volume durante a sua sessão.'));
  const choices = node('fieldset', 'settings-audio-options');
  choices.append(node('legend', 'visually-hidden', 'Tratamento do volume'));
  const inputs = [];
  let disposed = false;
  const memory = node('label', 'settings-audio-memory'), remember = node('input', '');
  remember.type = 'checkbox';remember.disabled = typeof controller?.setPreferences !== 'function';
  const memoryCopy = node('span', 'settings-audio-option-copy');
  memoryCopy.append(node('strong', '', 'Lembrar volume por canal'), node('small', '', 'Depois de ajustar um canal, seu volume será restaurado quando você voltar. Disponível quando o dispositivo permite controlar o volume.'));
  memory.append(remember, memoryCopy);
  const status = node('p', 'settings-audio-status');status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const update = () => {
    if (disposed) return;
    const preferences = controller?.getPreferences?.() || {mode:'original'};
    const current = controller?.getStatus?.() || {state:'unsupported'};
    for (const {input, row} of inputs) {
      input.checked = input.value === preferences.mode;
      row.classList.toggle('selected', input.checked);
    }
    remember.checked = preferences.rememberChannelVolume !== false;
    status.textContent = audioStatusMessage(current, preferences);status.dataset.state = current.state || 'idle';
  };
  for (const {mode, label, description} of AUDIO_CHOICES) {
    const row = node('label', 'settings-audio-option'), input = node('input', '');
    input.type = 'radio';input.name = 'audio-mode';input.value = mode;input.disabled = typeof controller?.setPreferences !== 'function';
    const copy = node('span', 'settings-audio-option-copy');copy.append(node('strong', '', label), node('small', '', description));
    row.append(input, copy);choices.append(row);inputs.push({input, row});
    input.addEventListener('change', async () => {
      if (!input.checked || disposed) return;
      try {
        const preference = controller.setPreferences({mode});
        // Start inside the user's gesture; awaiting first can lose activation.
        const activation = controller.requestActivation?.();
        await Promise.all([preference, activation]);
      }
      catch {if (!disposed) toast?.('Não foi possível alterar o ajuste de áudio. Tente novamente.');}
      update();
    });
  }
  remember.addEventListener('change', async () => {
    if (disposed) return;
    try {await controller.setPreferences({rememberChannelVolume:remember.checked});}
    catch {if (!disposed) toast?.('Não foi possível salvar a preferência de volume. Tente novamente.');}
    update();
  });
  section.append(choices, memory, status, node('p', 'settings-audio-note', 'O ajuste reduz picos e pode suavizar diferenças entre canais. O resultado depende do áudio recebido; não garante que todos os canais tenham o mesmo volume.'));
  container.append(section);update();
  const unsubscribe = controller?.subscribe?.(update);
  return () => {disposed = true;if (typeof unsubscribe === 'function') unsubscribe();};
}
