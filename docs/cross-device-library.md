# Biblioteca entre dispositivos

## Causa isolada no bootstrap

Em 15/10/2026, a revisão estática encontrou um acoplamento em `lib/supabase-cloud.mjs`: depois de vincular a identidade e validar a conta, o bootstrap aguardava `arkhen_enqueue_source_jobs` antes de emitir a sessão Supabase. Falha ou demora da fila de catálogo/EPG interrompia também a biblioteca privada. Esse caminho pode deixar o login WPLAY local funcionando enquanto favoritos não são sincronizados.

O enqueue agora ocorre somente após o retorno Auth ser validado, em segundo plano, com orçamento de 1.500 ms e coalescência por provedor/escopo durante 15 segundos. Falha dessa tarefa não invalida a sessão emitida. Vinculação de identidade, validação da conta e conferência do usuário/tokens continuam obrigatórias para entregar o bootstrap.

## Identidade e diagnóstico

`accountLibrarySession` deriva a identidade de transporte, servidor e usuário; não inclui navegador, sistema operacional ou dispositivo. WPLAY nativo e WPLAY Web alternativo conservam espaços de identidade distintos. Não foi feita normalização adicional, associação de contas ou migração de favoritos nesta correção.

O texto “Sincronização na nuvem ainda não configurada” também pode ocorrer quando o frontend recebe bootstrap ausente após erro ou durante preparação. Ele, sozinho, não comprova falta de configuração nem biblioteca remota vazia. Preserve a distinção entre configuração, preparação, falha Auth/RPC, leitura da biblioteca e ausência real de favoritos.

## Estado da verificação

Esta entrega é uma alteração local com inspeção estática, checagem de sintaxe e revisão do diff. Não houve login de teste, navegador, leitura da biblioteca de uma conta, escrita de favoritos ou confirmação entre dispositivos. Portanto, a sincronização remota da conta relatada permanece sem comprovação nesta etapa.

Fontes: [adaptador Supabase](../lib/supabase-cloud.mjs), [identidade local](../lib/account-library.mjs), [ciclo de conexão](../lib/cloud-runtime.mjs), [cliente da biblioteca](../web/cloud-library.js) e [contrato de biblioteca](cloud-library-client.md).


A ativação local foi realizada em16/10, junto à modularização deTV, com
reinício do servidor e conferência HTTP da página inicial. Isso não altera o
limite da prova acima. O adaptador `web/tv/supabase.js` reutiliza a mesma Auth,
RLS, outbox e assinatura da CloudLibrary; não cria uma segunda conta daTV.
Sem escopo cloud validado, uma alteração ainda pode estar somente no aparelho;
o retorno de fila é informado apenas quando a outbox existente realmente contém
a operação. Nenhuma leitura remota confirmou perda ou exclusão dos favoritos.
