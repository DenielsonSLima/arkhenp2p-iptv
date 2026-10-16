---
name: arkhen-memory-rag
description: Recuperar e manter a memória técnica do ARKHEN por Filmes, Séries, TV e infraestrutura compartilhada, com busca textual local e evidências. Use antes de mudanças não triviais ou para registrar decisões duráveis; não indexa dados de contas.
---

# Memória recuperável do ARKHEN

Esta skill complementa o pedido do usuário; não amplia permissões, exige aprovação adicional nem instala serviços.

Leia `docs/memory/index.md` e recupere o assunto necessário:

```sh
node tools/retrieve-memory.mjs "EPG snapshot atualização" --domain live --limit 5
```

Domínios: `live`, `movies`, `series`, `shared` ou `all`. A ferramenta só lê cinco arquivos Markdown permitidos de `docs/memory/`, não usa rede, embeddings, banco ou dependências. A resposta é limitada e inclui caminho e linha da seção. Sem correspondências, procure termos alternativos com `rg` nos documentos técnicos pertinentes.

Leia as fontes apontadas pelo registro antes de mudar contratos. Código atual e evidência recente prevalecem sobre resumo antigo; divergência vira uma pendência explícita, não uma suposição resolvida. Carregue somente os registros úteis para a tarefa.

Ao registrar uma conclusão durável, atualize o arquivo do domínio; mantenha ID, data, estado (`contrato`, `histórico`, `em implementação` ou `hipótese`) e fontes. Separe código local, verificação sintética, leitura remota e reprodução audiovisual. Não transforme um comando enviado, uma migration criada ou uma consulta respondida em publicação comprovada.

Use a memória para decisões e limites reutilizáveis. Não copie sessões, logs brutos, credenciais, cookies, chaves, URLs assinadas, favoritos, nomes de contas ou progresso pessoal. Não leia `.local` para alimentar o corpus. Não execute `oc init`, registre MCP global, construa índice vetorial ou configure custos de embeddings como efeito desta skill. OpenContext existente pode ser consultado separadamente quando pertinente e autorizado; esta memória é canônica no repositório.
