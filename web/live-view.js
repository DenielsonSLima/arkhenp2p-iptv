// TV cards own their layout here. Account state, playback and the visible-only
// program guide stay connected through the callbacks supplied by the app.
export function createLiveView({ node, button, artwork, image, makeFavorite, updateFavoriteButton, resolveLogo = () => '', logoGeometry = () => null, getGuide, onWatch }) {
  function createCard(item) {
    const card = node('article', 'live-card');
    const play = button('', 'channel-button', () => onWatch(item));
    play.setAttribute('aria-label', `Assistir ${item.name}`);

    const logo = node('div', 'channel-logo');
    const initials = item.name.replace(/^(?:CANAL|TV)\s*/i, '').slice(0, 2).toUpperCase();
    logo.append(node('span', 'channel-initial', initials));
    const poster = artwork(resolveLogo(item)) || artwork(item.poster);
    const original = artwork(item.posterOriginal) || artwork(item.poster);
    if (poster) {
      const graphic = image(poster, '', true, original), geometry = logoGeometry(poster);
      if (geometry) {
        // A failed local asset may fall back to the provider. Its padding can
        // differ, so never apply local bounds to a different image.
        const frame = () => {
          const local = graphic.getAttribute('src') === poster;
          graphic.classList.toggle('channel-logo-framed', local);
          for (const [property, value] of Object.entries(geometry)) graphic.style[property] = local ? value : '';
        };
        frame();graphic.addEventListener('load', frame);graphic.addEventListener('error', frame);
      }
      logo.append(graphic);
    }

    const copy = node('div', 'channel-copy');
    copy.append(
      node('span', 'on-air-label', 'AO VIVO'),
      node('h3', '', item.name),
      node('p', '', item.group || 'TV ao vivo')
    );
    play.append(logo, copy);
    card.append(play, makeFavorite(item));
    return card;
  }

  function mountCard(card, item) {
    updateFavoriteButton(card.querySelector('.card-favorite'), item);
    getGuide()?.observe(card, item);
  }

  return { createCard, mountCard };
}
