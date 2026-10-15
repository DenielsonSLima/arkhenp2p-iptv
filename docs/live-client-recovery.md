# Recuperação do player ao vivo — 15/10/2026

## Falhas corrigidas

O manifesto inicial tinha quatro segundos até o primeiro byte, embora o backend pudesse gastar mais tempo resolvendo a sessão e o catálogo OTT. A política inicial de TV agora permite 55 segundos até o primeiro byte e 60 segundos no total, cobrindo o prazo de abertura OTT de 40 segundos e a leitura do manifesto de dez segundos. Não há novo retry automático desse manifesto. Os prazos menores de playlists, segmentos e VOD foram preservados.

O player imersivo tratava qualquer evento `video.error` como terminal, mesmo durante recuperação administrada pelo HLS. No aplicativo, o controlador de transporte passa a ser responsável pela falha final. Uma falha terminal não desaparece apenas porque o buffer restante emite `playing`; é preciso iniciar outra tentativa. Um `waiting` atrasado após pausa voluntária também não abre a animação de espera.

O registro de diagnóstico podia chamar a seleção automática de qualidade de forma síncrona. O callback antigo então continuava executando e falhava o novo player. O módulo `hls-error-handler.js` verifica a instância e a geração antes e depois desses efeitos. Manifestos e erros atrasados de uma instância destruída não alteram a atual.

A recuperação de rede coalesce eventos duplicados e permite duas tentativas por interrupção. O orçamento só é renovado depois de 30 segundos com tempo de vídeo avançando; quadros congelados, pausa, buffering e repetições do evento `playing` não o renovam. Amostras duplicadas do mesmo quadro não contam como travamento. A primeira carga de fragmento também pode ser recuperada se o manifesto já estiver analisado. Uma fonte ainda sem manifesto não é reiniciada como se estivesse pronta.

## Preparação e programação

Uma alternativa automática da mesma família de canal conserva a preparação inicial. Se já havia reprodução, a espera passa para o modo compacto. Troca deliberada de canal e nova tentativa do usuário começam uma preparação própria.

O player recebe a programação vigente antes de desenhar o primeiro quadro de interface, usando o cache do card ou da reprodução anterior. O trabalho de EPG mantém o programa ainda válido durante uma resposta vazia transitória e continua isolado por conta e canal. Horários vencidos não são apresentados como programa atual.

## Verificação

- 50 testes focados de HLS, loader, qualidade, mensagens de API e EPG passaram.
- A fixture `.local/verify-live-recovery-browser.mjs` carrega a aplicação real em Chromium isolado, com HLS, mídia e respostas do provedor simulados. Verifica preparação após quatro segundos, erro de mídia durante recuperação, pausa, recuperação duplicada, alternativa nativa do mesmo canal, programação conservada após resposta vazia e rejeição de erro tardio da instância anterior.
- A mesma fixture confere que uma preparação inicial de nove segundos mantém esse tempo ao continuar na mesma fonte e que a interface de espera desaparece depois da recuperação.
- Evidência privada: `.local/live-recovery-browser-result.json` e `.local/live-recovery-browser.png`. Não contém credenciais nem URLs de transmissão.

Essa prova cobre estados da aplicação e corridas entre callbacks. Não certifica a disponibilidade do canal no servidor WPLAY nem a decodificação de mídia real; a validação final da experiência permanece com o usuário.
