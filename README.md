# SoulHub CLI

Install and manage AI agent persona templates for OpenClaw.

## Installation

```bash
npm install -g soulhub
```

Or use directly with npx:

```bash
npx soulhub <command>
```

## Commands

| Command | Description |
|---------|-------------|
| `soulhub search <keyword>` | Search agent templates by keyword |
| `soulhub info <name>` | Show detailed agent information |
| `soulhub install <name>` | Install an agent template |
| `soulhub list` | List installed agents |
| `soulhub update [name]` | Update installed agents |
| `soulhub uninstall <name>` | Remove an installed agent |
| `soulhub publish` | Validate and publish your agent |

## Usage

### Search for agents

```bash
soulhub search python
soulhub search "content writing"
```

### Install an agent

```bash
soulhub install coder-fullstack
soulhub install writer-blog --dir ./my-agents
```

### List installed agents

```bash
soulhub list
```

### Update agents

```bash
soulhub update              # Update all
soulhub update coder-python # Update specific agent
```

## Configuration

The CLI stores configuration in `~/.soulhub/config.json`.

### Custom Registry

Set a custom registry URL via environment variable:

```bash
export SOULHUB_REGISTRY_URL=https://your-registry.example.com
```

## Requirements

- Node.js >= 18.0.0

## License

MIT
