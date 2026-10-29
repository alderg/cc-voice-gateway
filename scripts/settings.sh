# Sourced by the start scripts: the settings in .secrets/gateway.env, which the
# setup assistant writes (src/settings.mjs), as environment variables. A
# variable that is already set wins. Every line is taken as NAME=value and
# never executed; anything but VOICE_GW_ names is skipped.
#
# The names set from the file go to the environment too, in
# VOICE_GW_SETTINGS_FROM_FILE, separated by spaces: so the gateway can tell
# them from values set outside, which win, and take a changed worker limit
# from the file while it runs (src/live.mjs). Names that a start script above
# this one listed there came from the file: they are read from it again.
#
# For bash 3.2 too, the /bin/bash of macOS: no mapfile, no associative arrays,
# and every empty array expanded with the ${a[@]+...} guard for set -u.
settings_from_file=() # the names load_settings set, for reload_settings and the log
settings_outside=()   # set before the first load: these win
for _name in $(compgen -e -X '!VOICE_GW_*'); do
  if [[ $_name == VOICE_GW_SETTINGS_FROM_FILE ]]; then continue; fi
  if [[ " ${VOICE_GW_SETTINGS_FROM_FILE-} " == *" $_name "* ]]; then
    unset "$_name"
    continue
  fi
  settings_outside+=("$_name")
done
unset _name
# The list holds what this load read: not the names reload_settings kept from
# an earlier one, which stay as they were, whatever the file says now.
load_settings() {
  local line name loaded=()
  settings_path=${VOICE_GW_SECRETS_DIR:-$ROOT/.secrets}/gateway.env
  if [ -r "$settings_path" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      name=${line%%=*}
      if [[ $line == *=* && $name =~ ^VOICE_GW_[A-Z0-9_]+$ && $name != VOICE_GW_SETTINGS_FROM_FILE && -z ${!name+x} ]]; then
        export "$name=${line#*=}"
        settings_from_file+=("$name")
        loaded+=("$name")
      fi
    done <"$settings_path"
  fi
  local IFS=' '
  export VOICE_GW_SETTINGS_FROM_FILE="${loaded[*]+"${loaded[*]}"}"
}
# The file again, for a script that runs long, such as the watchdog: what an
# earlier load set goes first, so that changed and removed lines count, except
# the names given here. Whatever was set from outside still wins.
reload_settings() {
  local name keep=" $* " kept=()
  for name in "${settings_from_file[@]+"${settings_from_file[@]}"}"; do
    if [[ $keep == *" $name "* ]]; then kept+=("$name"); else unset "$name"; fi
  done
  settings_from_file=("${kept[@]+"${kept[@]}"}")
  load_settings
}
load_settings
