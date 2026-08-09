# Mineflayer TUI Multi-Bot Manager

A terminal-based multi-bot manager for Minecraft, built with Node.js, [Mineflayer](https://github.com/PrismarineJS/mineflayer), and [neo-blessed](https://github.com/chjj/blessed). 

This program allows you to connect and manage multiple Minecraft bots simultaneously through a clean Terminal User Interface (TUI). It features automatic server authentication, GUI navigation (compass clicking), and independent log views for each bot.

## Features

* **Interactive TUI:** View logs, send commands, and monitor bots without terminal spam.
* **Multi-Bot Management:** Spin up multiple bots with staggered connection delays to avoid rate limits.
* **Auto-Authentication:** Automatically sends `/register` and `/login` before spawning in.
* **Auto-Navigation:** Automatically uses a server selector compass, clicks specific GUI slots, and executes warp commands.
* **Isolated State:** Each bot maintains its own isolated event logs, connection state, and timeout handlers.

## Prerequisites

* **Node.js** (v18+ recommended)
* A Minecraft server to connect to.

## Installation

1. Clone or download this repository.
2. Install the required dependencies:
   ```bash
   npm install mineflayer neo-blessed
