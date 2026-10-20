import { ChevronDownIcon, Loader2Icon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_MODEL_UPSTREAM_FETCH_BUTTON,
  TID_MODEL_UPSTREAM_PICKER,
  testId,
} from "@zcode/shared/test-ids";
import type { ProviderUpstreamModelsResult } from "@zcode/services";

/**
 * 拉取上游模型 ID 的弹窗内组件。网络 IO 通过注入的 fetcher 完成；
 * 组件只拥有过滤词与请求代次（stale 结果丢弃），不拥有草稿模型 ID。
 */
export function ProviderUpstreamModelPicker({
  disabled,
  fetching,
  result,
  onFetch,
  onSelect,
}: {
  disabled?: boolean;
  fetching: boolean;
  result: ProviderUpstreamModelsResult | null;
  onFetch: () => void;
  onSelect: (modelId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const models = result?.models ?? [];
  const error = result?.error;
  const fetchLabel = intl.formatMessage({ id: "settings.modelProvider.upstream.fetch" });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1 shrink-0 gap-1.5"
          disabled={disabled || fetching}
          onClick={onFetch}
          data-testid={TID_MODEL_UPSTREAM_FETCH_BUTTON}
          title={fetchLabel}
        >
          {fetching ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          )}
          {fetchLabel}
          <ChevronDownIcon className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command data-testid={TID_MODEL_UPSTREAM_PICKER}>
          <CommandInput
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.upstream.searchPlaceholder",
            })}
          />
          <CommandList>
            <CommandEmpty>
              {intl.formatMessage({ id: "settings.modelProvider.upstream.empty" })}
            </CommandEmpty>
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2 px-3 py-2 text-ui-sm text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {intl.formatMessage({
                    id: `settings.modelProvider.upstream.error.${error.code}`,
                  })}
                </span>
              </div>
            ) : null}
            {models.length > 0 ? (
              <CommandGroup>
                {models.map((modelId) => (
                  <CommandItem
                    key={modelId}
                    value={modelId}
                    data-testid={testId(TID_MODEL_UPSTREAM_PICKER, modelId)}
                    onSelect={() => {
                      onSelect(modelId);
                    }}
                    className="font-mono text-ui-sm"
                  >
                    {modelId}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
