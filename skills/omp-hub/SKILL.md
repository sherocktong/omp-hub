# omp-hub skill

Manage omp-hub profiles and models via natural language commands. This skill reads and writes `~/.omp/profiles.json` directly to update profile configurations.

## Trigger

Invoke this skill when the user asks to:
- Add models to an omp-hub profile
- Remove models from an omp-hub profile
- List models in a profile
- Set/update the default model for a profile
- View profile details
- Any natural language request involving omp-hub profiles and models

## Profile File Location

`~/.omp/profiles.json`

## Capabilities

### 1. Add models to a profile

**Example requests:**
- "Add kimi-for-coding to my work profile"
- "Add claude-sonnet-4-6 to the oss profile"
- "Add model X to profile Y"

**Behavior:**
1. Read `~/.omp/profiles.json`
2. Find the specified profile
3. Add the new models to the `models` array (or create it if not exists), max 3 models
4. Update `model` field to the first model in the list
5. Write back the updated JSON
6. Confirm the changes to the user

### 2. Remove models from a profile

**Example requests:**
- "Remove kimi-for-coding from my work profile"
- "Delete gpt-5.2 from the oss profile"
- "Remove models X and Y from profile Z"

**Behavior:**
1. Read `~/.omp/profiles.json`
2. Find the specified profile
3. Remove the specified models from the `models` array
4. Update `model` field to the new first model (or remove if empty)
5. Write back the updated JSON
6. Confirm the changes to the user

### 3. List models in a profile

**Example requests:**
- "What models are in my work profile?"
- "List models for the oss profile"
- "Show me the models in profile X"

**Behavior:**
1. Read `~/.omp/profiles.json`
2. Display the `models` array or `model` field for the specified profile

### 4. Set default model

**Example requests:**
- "Set the default model for work to kimi-for-coding"
- "Make claude-sonnet-4-6 the first model in my oss profile"
- "Change the primary model of profile X to Y"

**Behavior:**
1. Read `~/.omp/profiles.json`
2. Reorder the `models` array so the specified model is first
3. Update `model` field to match
4. Write back the updated JSON

## Profile JSON Structure

```json
{
  "profiles": {
    "profilename": {
      "provider": "kimi-coding",
      "model": "primary-model-id",
      "models": ["model1", "model2", "model3"],
      "thinking": "high",
      "token": "api-token",
      "url": "https://proxy.example.com/coding"
    }
  },
  "default": "profilename"
}
```

## Implementation Notes

- Always validate JSON before writing
- Preserve all existing profile fields (provider, token, url, thinking, etc.)
- Handle edge cases: profile doesn't exist, model not found, etc.
- Provide clear success/error messages
- When adding models, avoid duplicates
- When removing models, handle the case where all models are removed
- Max 3 models per profile
