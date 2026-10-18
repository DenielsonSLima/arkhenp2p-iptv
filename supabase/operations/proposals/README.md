# Propostas não instaladas nesta intervenção

Estes arquivos ficam fora de `supabase/migrations/` para não serem aplicados
automaticamente. Foram revisados estaticamente, sem testes ou execução das
rotinas. A tentativa do wrapper legado retornou HTTP 544; a leitura posterior
das 01h36 UTC conservava o hash antigo. A proposta de lote de fonte não foi
enviada ao banco.

- `20261017012951_arkhen_marker_legacy_discovery_bounded_wrapper.sql`:
  compatibilidade para um worker antigo. O worker novo usa `discoverBatch`;
  verificar a necessidade real antes de instalar. O wrapper preserva contagem
  real, mas pode impor o cooldown antigo a cada página.
- `20261017013103_arkhen_marker_source_batch_bounded_candidates.sql`:
  limita candidatas antes do ranking TMDB. A contagem `excluded_groups` ainda
  agrega a geração; não torna todo o RPC limitado à página.

Os hashes de baseline devem ser conferidos novamente antes de qualquer envio.
O incidente atual mostrou pouco volume de I/O PostgreSQL na janela contida;
essas propostas não são consideradas solução comprovada para a pressão do host.

Fonte: `docs/supabase-cpu-recheck-20261016.md`.
