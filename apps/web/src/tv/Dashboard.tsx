import { GAME_PLATFORM_LABELS, type GameMeta, type PhoneSkinId } from '@mgo/protocol';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { splitPlayTime } from '../playTime';
import { skinBase } from '../skin/registry';
import type { LoadedSkin } from '../skin/types';
import { useTheme } from '../theme';
import { GameArtwork, TvGameTile, tvPlatform, type TvFilter, type TvGameGroup } from './Library';

export type TvSection = 'home' | 'library' | 'collections' | 'phones';
export type TvCollection = { filter: TvFilter; label: string; icon: string; count: number };

export function TvNavigation({ section, onSelect, onSettings }: {
  section: TvSection; onSelect: (section: TvSection) => void; onSettings: () => void;
}) {
  const theme = useTheme();
  return <header className="tv-head">
    <img className="tv-brand" src={theme === 'dark' ? '/graphics/brand/logo-horizontal.svg' : '/graphics/brand/logo-light.svg'} alt="MGO" />
    <nav className="tv-nav" data-tv-row aria-label={t('TV navigation')}>
      {([['home', 'Home', 'home'], ['library', 'Library', 'library'], ['collections', 'Collections', 'layers'], ['phones', 'Phones', 'phone']] as const).map(([id, label, icon]) =>
        <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => onSelect(id)}><Icon name={icon} />{t(label)}</button>)}
      <button type="button" onClick={onSettings}><Icon name="sliders" />{t('Settings')}</button>
    </nav>
  </header>;
}

export function TvFooter() {
  return <footer className="tv-footer">
    <span><Icon name="gamepad" /> {t('TV Mode')}</span>
    <div className="tv-footer-actions">
      <span><kbd><Icon name="menu" /></kbd> {t('Menu')}</span>
      <span><kbd>A</kbd> {t('Select')}</span>
      <span><kbd>B</kbd> {t('Back')}</span>
    </div>
  </footer>;
}

export function TvCollectionCards({ collections, onSelect }: { collections: TvCollection[]; onSelect: (filter: TvFilter) => void }) {
  return <div className="tv-collection-grid" data-tv-row>{collections.map(({ filter, label, icon, count }) =>
    <button type="button" className="tv-collection-card" key={filter} onClick={() => onSelect(filter)}>
      <Icon name={icon} /><span>{t(label)}</span><small>{count}</small>
    </button>)}
  </div>;
}

export function TvPhoneCards({ phones, active, onView }: { phones: LoadedSkin[]; active?: PhoneSkinId; onView: (phone: LoadedSkin) => void }) {
  return <div className="tv-handset-grid" data-tv-row>{phones.map(phone => {
    const { id, manufacturer, model } = phone.config;
    return <button key={id} type="button" className="tv-handset-card" data-selected={id === active || undefined} onClick={() => onView(phone)}>
      <img src={skinBase(id) + 'preview.webp'} alt="" loading="lazy" />
      <span><strong>{model}</strong><small>{manufacturer}</small></span>
      {id === active && <Icon name="check" title={t('Default phone')} />}
    </button>;
  })}</div>;
}

function SpotlightFacts({ game, phone }: { game: GameMeta; phone?: LoadedSkin }) {
  const platform = GAME_PLATFORM_LABELS[tvPlatform(game)];
  const play = splitPlayTime(game.playSeconds);
  const duration = play.kind === 'none' ? null : play.kind === 'short' ? t('< 1 min')
    : play.h ? t('{h} h {m} min', { h: play.h, m: String(play.m).padStart(2, '0') }) : t('{m} min', { m: play.m });
  const date = game.lastPlayedAt ? new Date(game.lastPlayedAt) : null;
  const lastPlayed = date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(document.documentElement.lang || 'en', { dateStyle: 'medium' }).format(date) : null;
  const facts = [
    ['device', 'Platform', platform],
    ['clock', 'Time played', duration],
    ['clock', 'Last played', lastPlayed],
    ['phone', 'Phone', phone && `${phone.config.manufacturer} ${phone.config.model}`],
  ];
  return <dl className="tv-spotlight-facts">{facts.map(([icon, label, value]) => value && label && icon &&
    <div key={label}><Icon name={icon} /><dt>{t(label)}</dt><dd>{value}</dd></div>)}
  </dl>;
}

export function TvHome({ highlights, spotlight, played, added, collections, phones, phone, activePhone, shuffle,
  onHighlight, onOpen, onPlay, onChoosePhone, onLibrary, onSection, onPhone }: {
  highlights: TvGameGroup[]; spotlight?: TvGameGroup; played: boolean; added: TvGameGroup[]; collections: TvCollection[];
  phones: LoadedSkin[]; phone?: LoadedSkin; activePhone?: PhoneSkinId; shuffle?: () => void;
  onHighlight: (id: string) => void; onOpen: (game: TvGameGroup) => void; onPlay: (lights?: boolean) => void; onChoosePhone: () => void;
  onLibrary: (filter: TvFilter) => void; onSection: (section: TvSection) => void;
  onPhone: (phone: LoadedSkin) => void;
}) {
  const game = spotlight?.game;
  return <main className="tv-home" aria-label={t('Home')}>
    {game ? <section className="tv-spotlight" aria-labelledby="tv-spotlight-heading">
      <div className="tv-shelf-heading"><h2 id="tv-spotlight-heading"><Icon name="play" />{t(played ? 'Continue playing' : 'Start playing')}</h2></div>
      <div className="tv-spotlight-cards" data-tv-row>{highlights.map(group => <TvGameTile key={group.id} group={group}
        preferred={group.id === spotlight.id} onFocus={() => onHighlight(group.id)} onOpen={() => onOpen(group)} />)}</div>
      <div className="tv-spotlight-details">
        <div className="tv-spotlight-art" aria-hidden="true"><GameArtwork game={game} /></div>
        <div className="tv-spotlight-summary">
          <div className="tv-spotlight-title"><h1>{game.name}</h1>
            {game.classification?.primaryGenre && <p>{t(game.classification.primaryGenre)}</p>}</div>
          <SpotlightFacts game={game} phone={phone} />
        </div>
        <div className="tv-actions" data-tv-row>
          <button type="button" className="tv-primary" onClick={() => onPlay()}><Icon name="play" />{t(game.lastPlayedAt ? 'Play again / Resume' : 'Play')}</button>
          <button type="button" onClick={onChoosePhone}><Icon name="phone" />{t('Choose a phone')}</button>
          <button type="button" onClick={() => onPlay(true)}><Icon name="moon" />{t('Lights Out')}</button>
          {shuffle && <button type="button" onClick={shuffle}><Icon name="shuffle" />{t('Shuffle')}</button>}
        </div>
      </div>
    </section> : <section className="tv-empty">
      <h1>{t('Your library is empty')}</h1>
      <button type="button" className="tv-primary" data-tv-prefer onClick={() => onLibrary('all')}>{t('Library')}</button>
    </section>}
    {added.length > 0 && <section aria-labelledby="tv-added-heading">
      <div className="tv-shelf-heading"><h2 id="tv-added-heading"><Icon name="download" />{t('Recently added')}</h2><button className="tv-see-all" type="button" onClick={() => onLibrary('added')}>{t('See all')} ›</button></div>
      <div className="tv-added-grid" data-tv-row>{added.map(group => <TvGameTile key={group.id} group={group} onOpen={() => onOpen(group)} />)}</div>
    </section>}
    <section aria-labelledby="tv-collections-heading">
      <div className="tv-shelf-heading"><h2 id="tv-collections-heading"><Icon name="layers" />{t('Collections')}</h2><button className="tv-see-all" type="button" onClick={() => onSection('collections')}>{t('See all')} ›</button></div>
      <TvCollectionCards collections={collections.slice(0, 6)} onSelect={onLibrary} />
    </section>
    {phones.length > 0 && <section aria-labelledby="tv-phones-heading">
      <div className="tv-shelf-heading"><h2 id="tv-phones-heading"><Icon name="phone" />{t('Phones')}</h2><button className="tv-see-all" type="button" onClick={() => onSection('phones')}>{t('See all')} ›</button></div>
      <TvPhoneCards phones={phones.slice(0, 5)} active={activePhone} onView={onPhone} />
    </section>}
  </main>;
}
