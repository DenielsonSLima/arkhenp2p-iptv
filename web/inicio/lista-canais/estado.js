/** Feedback only. Channel selection, order and watch time stay in the RPC. */
export function homeChannelFeedback(state = {}, hasItems = false) {
  if (state.loading) return {phase: 'loading', retry: false, message: hasItems
    ? 'Atualizando seus canais…' : 'Carregando seus canais…'};
  if (state.waiting) return {phase: 'waiting', retry: true, message: hasItems
    ? 'A sincronização dos canais está indisponível. A última seleção continua disponível.'
    : 'Aguardando a sincronização para carregar seus canais.'};
  if (state.error) return {phase: 'error', retry: true, message: hasItems
    ? 'Não foi possível atualizar seus canais. A última seleção continua disponível.'
    : 'Não foi possível carregar seus canais agora.'};
  if (!hasItems) return {phase: state.data ? 'empty' : 'initial', retry: false,
    message: state.data ? 'Assista aos seus canais para vê-los aqui.'
      : 'Preparando seus canais…'};
  return {phase: 'ready', retry: false, message: ''};
}
