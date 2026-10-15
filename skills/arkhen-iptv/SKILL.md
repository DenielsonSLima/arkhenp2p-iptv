---
name: arkhen-iptv
description: Integrar catálogo e reprodução WPLAY no ARKHEN preservando servidores, conta, IDs e experiência visual do produto.
---

Leia `docs/engineering-recovery.md` e `docs/wplay-playback-contract.md` no repositório.

WPLAY fornece autenticação, catálogo e mídia. O site confirmado pelo usuário é `https://player.wplayott.com/auth`. A UI ARKHEN e a biblioteca privada são responsabilidades distintas do transporte do provedor.

Separe Filmes (detalhes/VOD HTTP), Séries (temporadas/episódios/progresso/marcadores) e TV (catálogo/EPG/jogos/transporte ao vivo). Um módulo não inicializa a engine ou recarrega o catálogo dos outros.

Preserve IDs/propriedade da biblioteca ao integrar o player web. Um ID OTT derivado por hash não equivale ao ID nativo. Associe canais apenas com evidência explícita ou título completo conservador e único; preserve números e regiões, rejeite ambiguidades.

Mantenha cookies, tokens e fontes de reprodução no backend da sessão. A coleção de metadados global não contém credenciais, URLs privadas ou progresso pessoal. Registre somente diagnósticos sanitizados.
