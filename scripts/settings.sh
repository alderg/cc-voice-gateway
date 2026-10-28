# Sourced by the start scripts: the settings in .secrets/gateway.env, which the
# setup assistant writes (src/settings.mjs), as environment variables. A
# variable that is already set wins. Every line is taken as NAME=value and
# never executed; anything but VOICE_GW_ names is skipped.
load_settings() {
  local file=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}/gateway.env line name
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    name=${line%%=*}
    if [[ $line == *=* && $name =~ ^VOICE_GW_[A-Z0-9_]+$ && -z ${!name+x} ]]; then
      export "$name=${line#*=}"
    fi
  done <"$file"
}
load_settings
