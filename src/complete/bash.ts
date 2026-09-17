import { OMP_PROVIDERS, THINKING_LEVELS } from "../types.js";

export const BASH_COMPLETION = `_omp-hub_profile_names() {
  local profiles_file="\${OMP_HUB_PROFILES_FILE:-\$HOME/.omp/profiles.json}"
  if [[ -f "$profiles_file" ]]; then
    command python3 -c "
import json
data = json.load(open('$profiles_file'))
for name in data.get('profiles', {}):
    print(name)
" 2>/dev/null
  fi
}

_omp-hub_profiles() {
  COMPREPLY=($(compgen -W "$(_omp-hub_profile_names)" -- "\${cur}"))
}

_omp-hub_models_for_profile() {
  local profile_name="$1"
  local profiles_file="\${OMP_HUB_PROFILES_FILE:-\$HOME/.omp/profiles.json}"
  if [[ -f "$profiles_file" && -n "$profile_name" ]]; then
    local models
    models=$(command python3 -c "
import json
data = json.load(open('$profiles_file'))
p = data.get('profiles', {}).get('$profile_name', {})
models = p.get('models')
if isinstance(models, list):
    for m in models:
        if m:
            print(m)
else:
    m = p.get('model')
    if m:
        print(m)
" 2>/dev/null)
    COMPREPLY=($(compgen -W "$models" -- "\${cur}"))
  fi
}

_omp-hub() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="profile use run completion help"

  local profile_subcmds="add update list view remove rename default"
  local thinking_levels="${THINKING_LEVELS.join(" ")}"
  local providers="${OMP_PROVIDERS.join(" ")}"

  # Top-level command
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
    return 0
  fi

  local cmd="\${COMP_WORDS[1]}"

  case "$cmd" in
    profile)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "$prev" == "view" || "$prev" == "remove" ]]; then
        _omp-hub_profiles
      elif [[ "$prev" == "default" ]]; then
        COMPREPLY=($(compgen -W "--built-in $(_omp-hub_profile_names)" -- "$cur"))
      elif [[ "$prev" == "rename" ]]; then
        _omp-hub_profiles
      elif [[ "$prev" == "profile" ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "\${COMP_WORDS[2]}" == "update" && \${COMP_CWORD} -eq 3 ]]; then
        _omp-hub_profiles
      elif [[ "\${COMP_WORDS[2]}" == "update" ]]; then
        if [[ "$prev" == "--thinking" ]]; then
          COMPREPLY=($(compgen -W "$thinking_levels" -- "$cur"))
        elif [[ "$prev" == "--provider" || "$prev" == "-p" ]]; then
          COMPREPLY=($(compgen -W "$providers" -- "$cur"))
        elif [[ "$prev" == "--model" || "$prev" == "-m" || "$prev" == "--delete-model" || "$prev" == "-d" ]]; then
          _omp-hub_models_for_profile "\${COMP_WORDS[3]}"
        else
          local update_opts="--model -m --delete-model -d --token -t --url -u --provider -p --thinking"
          COMPREPLY=($(compgen -W "$update_opts" -- "$cur"))
        fi
      elif [[ "\${COMP_WORDS[2]}" == "add" && \${COMP_CWORD} -gt 3 ]]; then
        if [[ "$prev" == "--thinking" ]]; then
          COMPREPLY=($(compgen -W "$thinking_levels" -- "$cur"))
        elif [[ "$prev" == "--provider" || "$prev" == "-p" ]]; then
          COMPREPLY=($(compgen -W "$providers" -- "$cur"))
        else
          local add_opts="--model -m --token -t --url -u --provider -p --thinking"
          COMPREPLY=($(compgen -W "$add_opts" -- "$cur"))
        fi
      fi
      ;;
    use|run)
      if [[ "$prev" == "--built-in" ]]; then
        :
      else
        COMPREPLY=($(compgen -W "--built-in $(_omp-hub_profile_names)" -- "$cur"))
      fi
      ;;
  esac

  return 0
}

complete -F _omp-hub omp-hub
`;
