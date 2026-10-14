import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedMovies } from '../web/related-movies.js';
const current = {id:'1',kind:'movie',name:'Filme atual',genre:'Filmes | Ação, Thriller',categoryId:'action'};
test('related movies prefer actual shared genres, omit current title and unrelated content',()=>{
  const items=[current,{id:'2',kind:'movie',name:'Ação e suspense',genre:'Ação, Thriller',categoryId:'action',rating:7},{id:'3',kind:'movie',name:'Comédia',group:'Comédia',categoryId:'comedy'},{id:'4',kind:'movie',name:'Outra ação',group:'Ação',categoryId:'action',rating:8},{id:'5',kind:'series',name:'Série de ação',genre:'Ação'},{id:'6',kind:'movie',name:'Filme atual',genre:'Ação',categoryId:'action'}];
  assert.deepEqual(relatedMovies(current,items).map(item=>item.id),['2','4']);
});
test('related movie selection deduplicates accents, respects limits and does not invent similarities',()=>{
  const items=[{id:'2',kind:'movie',name:'Ação',group:'Ação',categoryId:'action'},{id:'3',kind:'movie',name:'Acao',group:'Ação',categoryId:'action'},{id:'4',kind:'movie',name:'Outro',group:'Ação',categoryId:'action'}];
  assert.deepEqual(relatedMovies(current,items,1).map(item=>item.id),['2']);
  assert.deepEqual(relatedMovies({id:'9',kind:'movie',name:'Sem informação'},items),[]);
});

test('native genre lists rank shared themes and never recommend a film just because both are releases',()=>{
  const matchbox={id:'1',kind:'movie',name:'Matchbox',genre:'Filmes/Ação, Filmes/Comédia, Filmes/Aventura, Filmes/Lançamentos',categoryId:'releases'};
  const items=[
    {id:'2',kind:'movie',name:'Documentário recente',genre:'Filmes/Documentários, Filmes/Lançamentos',categoryId:'releases',rating:10},
    {id:'3',kind:'movie',name:'Só lançamentos',group:'Filmes/Lançamentos',categoryId:'releases',rating:10},
    {id:'4',kind:'movie',name:'Aventura cômica',genre:'Filmes/Comédia, Filmes/Aventura',categoryId:'adventure',rating:7},
    {id:'5',kind:'movie',name:'Ação',genre:'Filmes/Ação, Filmes/Lançamentos',categoryId:'releases',rating:9},
    {id:'6',kind:'movie',name:'Ação, aventura e comédia',genre:'Filmes/Ação, Filmes/Comédia, Filmes/Aventura',categoryId:'action',rating:6},
  ];
  assert.deepEqual(relatedMovies(matchbox,items).map(item=>item.id),['6','4','5']);
});

test('generic shelves, studios, release years and quality labels are not genre matches',()=>{
  for(const group of ['Filmes - Lançamentos 2026','Filmes/Novidades','Filmes | Destaques','Filmes/Netflix','Filmes/4K','Filmes/2026']){
    assert.deepEqual(relatedMovies({id:'1',name:'Primeiro',kind:'movie',group,categoryId:'same'},[{id:'2',name:'Segundo',kind:'movie',group,categoryId:'same'}]),[]);
  }
  assert.deepEqual(relatedMovies({id:'1',name:'Sem gênero',kind:'movie',categoryId:'same'},[{id:'2',name:'Outro',kind:'movie',categoryId:'same'}]),[]);
});

test('all supplied category names contribute specific genres when a catalog item lacks details',()=>{
  const title={id:'1',kind:'movie',name:'Ação',genre:'Filmes/Ação, Filmes/Aventura'};
  const items=[{id:'2',kind:'movie',name:'Duas categorias',group:'Lançamentos',groupNames:['Filmes/Lançamentos','Filmes/Ação','Filmes/Aventura'],rating:6},{id:'3',kind:'movie',name:'Uma categoria',group:'Filmes - Ação',rating:9}];
  assert.deepEqual(relatedMovies(title,items).map(item=>item.id),['2','3']);
});
