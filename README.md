<div align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="apps/web/public/graphics/brand/logo-light.svg">
    <img src="apps/web/public/graphics/brand/logo-horizontal.svg" alt="MGO" width="420">
  </picture>

  <h1>Mobile Games Online</h1>

  <p><strong>Your Java ME, Symbian and N-Gage games in a browser, on the phones they were made for.</strong></p>

  <p>Self-hosted on a NAS, Linux server or Proxmox · Keyboard, touch and gamepad · Persistent saves</p>

  <p><a href="https://github.com/grayhex/MGO/releases">Releases</a> · <a href="docs/DOCKER.md">Docker guide</a> · <a href="docs/PROXMOX.md">Proxmox guide</a> · <a href="README.ru.md">Русский</a></p>

  <a href="https://github.com/grayhex/MGO/actions/workflows/ci.yml"><img src="https://github.com/grayhex/MGO/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>

  <img src="docs/img/player.png" alt="MGO playing a mobile game in a Nokia N95 skin" width="800">
</div>

## What you can do

- **Play in a real handset layout.** Pick from 16 phones with interactive keys, zoom into the display, or dim the interface with Lights Out. Use a keyboard, gamepad, or touch controls.
- **Bring your own collection.** Import separate folders for Java ME, N-Gage and Symbian. Browse by platform and genre, see the resolution for each known build, and return to the running game from the library.
- **Find builds and fill in game cards.** Use the J2ME Archive index to identify builds and the curated list to find individual JARs. Add descriptions and screenshots with My Abandonware or MobyGames.
- **Keep your progress on the server.** MGO stores saves and game settings across browser sessions. Choose a MIDI SoundFont for Java ME and see emulator status in Settings.

## Library, phones and settings screenshots
<div align="center">
  
<img src="docs/img/lib.png" alt="MGO library in tile view" width="760">

<img src="docs/img/phones.png" alt="MGO phone catalog" width="760">

<img src="docs/img/settings.png" alt="MGO settings" width="760">

</div>

## Install

**Docker Compose on a NAS or Linux (x86-64)**

```sh
curl -fsSLO https://raw.githubusercontent.com/grayhex/MGO/main/compose.yaml
docker compose up -d
```

In Portainer or a NAS container manager, deploy the same file as a stack. Open `https://<server-address>:8443` from your home network. [Compose file](compose.yaml) · [Docker and NAS guide](docs/DOCKER.md) · [HTTPS setup](docs/HTTPS.md)

**Proxmox VE** · Run MGO in an unprivileged LXC with the [Proxmox installer](docs/PROXMOX.md).

## Play

1. Finish the setup wizard. Upload games or connect the folders that already hold them. You can also start a Java ME collection from the curated list.
2. Select a phone and press Play. Click a library row to open its game card. Use the **Screen** view for a larger picture with the handset keypad alongside it.
3. For Symbian and N-Gage, add your device firmware in **Settings → Firmware**. The model and product code guide you to a matching archive. [Firmware guide](docs/SYMBIAN.md)

[Library and metadata](docs/LIBRARY.md) · [Controls](docs/PLAYER_CONTROLS.md) · [Backups](docs/BACKUP.md) · [Changes](CHANGELOG.md)

## Built with

- [KEmulator nnmod](https://github.com/shinovon/KEmulator) runs Java ME games.
- [EKA2L1](https://github.com/EKA2L1/EKA2L1) runs Symbian and N-Gage games.
- [J2ME Archive Search](https://github.com/toca-1/new-j2me-software-archive-search) supplies the Java ME build index, with [J2ME Vault](https://huggingface.co/datasets/M5-Dev/j2me-vault) and [Internet Archive](https://archive.org/details/96x65pixels_j2me) for selected downloads.
- [My Abandonware](https://www.myabandonware.com/), [MobyGames](https://www.mobygames.com/), [All About Symbian](https://allaboutsymbian.com/n-gage-games/original/) and [LaunchBox Games Database](https://gamesdb.launchbox-app.com/) supply game information.

MGO is [MIT licensed](LICENSE). Emulator components follow their upstream licenses.
