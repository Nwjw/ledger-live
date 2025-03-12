import React, { useEffect, PureComponent, useState } from "react";
import { useDispatch } from "react-redux";
import styled from "styled-components";
import { Trans } from "react-i18next";
import { concat, from, Subscription } from "rxjs";
import { ignoreElements, filter, map, retry } from "rxjs/operators";
import { Account } from "@ledgerhq/types-live";
import { isAccountEmpty } from "@ledgerhq/live-common/account/index";
import { openModal } from "~/renderer/actions/modals";
import { DeviceShouldStayInApp, UnresponsiveDeviceError } from "@ledgerhq/errors";
import { getCurrencyBridge } from "@ledgerhq/live-common/bridge/index";
import uniq from "lodash/uniq";
import { urls } from "~/config/urls";
import logger from "~/renderer/logger";
import { prepareCurrency } from "~/renderer/bridge/cache";
import TrackPage from "~/renderer/analytics/TrackPage";
import RetryButton from "~/renderer/components/RetryButton";
import Box from "~/renderer/components/Box";
import Button from "~/renderer/components/Button";
import CurrencyBadge from "~/renderer/components/CurrencyBadge";
import AccountsList, { AccountListProps } from "~/renderer/components/AccountsList";
import Spinner from "~/renderer/components/Spinner";
import Text from "~/renderer/components/Text";
import ErrorDisplay from "~/renderer/components/ErrorDisplay";
import Switch from "~/renderer/components/Switch";
import { StepProps } from "..";
import InfoCircle from "~/renderer/icons/InfoCircle";
import ToolTip from "~/renderer/components/Tooltip";
import { CryptoOrTokenCurrency } from "@ledgerhq/types-cryptoassets";
import { getLLDCoinFamily } from "~/renderer/families";
import { groupAddAccounts } from "@ledgerhq/live-wallet/addAccounts";
import { getDefaultAccountName } from "@ledgerhq/live-wallet/accountName";
import BigNumber from "bignumber.js";
import RequestAmount from "~/renderer/components/RequestAmount";

type Props = AccountListProps & { defaultSelected: boolean; currency: CryptoOrTokenCurrency };

const statusCodeErrorMap = new Map<number, (appName: string) => Error>([
  [0x6982, appName => new DeviceShouldStayInApp(undefined, { appName })],
  [0x6700, appName => new DeviceShouldStayInApp(undefined, { appName })],
  [0x6d09, appName => new DeviceShouldStayInApp(undefined, { appName })],
]);

const remapTransportError = (err: unknown, appName: string): Error => {
  if (!err || typeof err !== "object") return err as Error;
  const { statusCode } = err as { name: string; statusCode: number };
  const errorFromStatusCode = statusCodeErrorMap.get(statusCode)?.(appName);
  return errorFromStatusCode || (err as Error);
};

const LoadingRow = styled(Box).attrs(() => ({
  horizontal: true,
  borderRadius: 1,
  px: 3,
  alignItems: "center",
  justifyContent: "center",
  mt: 1,
}))`
  height: 48px;
  border: 1px dashed ${p => p.theme.colors.palette.text.shade60};
`;

const SectionAccounts = ({ defaultSelected, ...rest }: Props) => {
  useEffect(() => {
    if (defaultSelected && rest.onSelectAll) rest.onSelectAll(rest.accounts);
  }, []);
  return <AccountsList {...rest} />;
};

class StepImport extends PureComponent<StepProps, { showAllCreatedAccounts: boolean }> {
  constructor(props: StepProps) {
    super(props);
    this.state = { showAllCreatedAccounts: false };
  }

  componentDidMount() {
    this.props.setScanStatus("scanning");
  }

  componentDidUpdate(prevProps: StepProps) {
    if (prevProps.scanStatus !== "scanning" && this.props.scanStatus === "scanning") {
      this.startScanAccountsDevice();
    }
    if (prevProps.scanStatus !== "finished" && this.props.scanStatus === "finished") {
      this.unsub();
    }
  }

  componentWillUnmount() {
    this.unsub();
  }

  scanSubscription: Subscription | null = null;
  unsub = () => {
    if (this.scanSubscription) this.scanSubscription.unsubscribe();
  };

  startScanAccountsDevice() {
    this.unsub();
    try {
      const { currency, device, setScanStatus, setScannedAccounts, blacklistedTokenIds } = this.props;
      if (!currency || !device) throw new UnresponsiveDeviceError();
      const mainCurrency = currency.type === "TokenCurrency" ? currency.parentCurrency : currency;
      const bridge = getCurrencyBridge(mainCurrency);
      let onlyNewAccounts = true;
      const syncConfig = { paginationConfig: { operations: 20 }, blacklistedTokenIds };
      this.scanSubscription = concat(
        from(prepareCurrency(mainCurrency)).pipe(ignoreElements()),
        bridge.scanAccounts({ currency: mainCurrency, deviceId: device.deviceId, syncConfig }),
      )
        .pipe(filter(e => e.type === "discovered"), map(e => e.account), retry(2))
        .subscribe({
          next: account => {
            const { scannedAccounts, checkedAccountsIds, existingAccounts } = this.props;
            const hasAlreadyBeenScanned = !!scannedAccounts.find(a => account.id === a.id);
            const hasAlreadyBeenImported = !!existingAccounts.find(a => account.id === a.id);
            const isNewAccount = isAccountEmpty(account);
            if (!isNewAccount && !hasAlreadyBeenImported) onlyNewAccounts = false;
            if (!hasAlreadyBeenScanned) {
              setScannedAccounts({
                scannedAccounts: [...scannedAccounts, account],
                checkedAccountsIds: onlyNewAccounts
                  ? hasAlreadyBeenImported || checkedAccountsIds.length > 0
                    ? checkedAccountsIds
                    : [account.id]
                  : !hasAlreadyBeenImported && !isNewAccount
                    ? uniq([...checkedAccountsIds, account.id])
                    : checkedAccountsIds,
              });
            }
          },
          complete: () => setScanStatus("finished"),
          error: err => {
            logger.critical(err);
            setScanStatus("error", remapTransportError(err, currency.name));
          },
        });
    } catch (err) {
      logger.critical(err);
      this.props.setScanStatus("error", err as Error);
    }
  }

  handleRetry = () => {
    this.unsub();
    this.props.resetScanState();
    this.startScanAccountsDevice();
  };

  handleToggleAccount = (account: Account) => {
    const { checkedAccountsIds, setScannedAccounts } = this.props;
    const isChecked = checkedAccountsIds.includes(account.id);
    setScannedAccounts({
      checkedAccountsIds: isChecked
        ? checkedAccountsIds.filter(id => id !== account.id)
        : [...checkedAccountsIds, account.id],
    });
  };

  handleSelectAll = (accountsToSelect: Account[]) => {
    const { setScannedAccounts, checkedAccountsIds } = this.props;
    setScannedAccounts({ checkedAccountsIds: uniq(checkedAccountsIds.concat(accountsToSelect.map(a => a.id))) });
  };

  handleUnselectAll = (accountsToRemove: Account[]) => {
    const { setScannedAccounts, checkedAccountsIds } = this.props;
    setScannedAccounts({ checkedAccountsIds: checkedAccountsIds.filter(id => !accountsToRemove.some(a => id === a.id)) });
  };

  renderLegacyAccountsToggle() {
    const { currency } = this.props;
    if (!currency) return null;
    const { showAllCreatedAccounts } = this.state;
    return (
      <Box ml="auto" mr={3}>
        <Box color="palette.text.shade60" horizontal alignItems="center">
          <Text fontSize={2}><Trans i18nKey="addAccounts.createNewAccount.showAllAddressTypes" /></Text>
          <ToolTip content={<Trans i18nKey="addAccounts.createNewAccount.showAllAddressTypesTooltip" values={{ family: currency.name }} />}>
            <Box mx={1}><InfoCircle size={14} /></Box>
          </ToolTip>
          <Switch isChecked={showAllCreatedAccounts} small onChange={() => this.setState({ showAllCreatedAccounts: !showAllCreatedAccounts })} />
        </Box>
      </Box>
    );
  }

  render() {
    const { scanStatus, currency, err, scannedAccounts, checkedAccountsIds, existingAccounts, setAccountName, editedNames, t } = this.props;
    if (!currency) return null;
    const mainCurrency = currency.type === "TokenCurrency" ? currency.parentCurrency : currency;
    const newAccountSchemes = scannedAccounts
      .filter(a1 => !existingAccounts.map(a2 => a2.id).includes(a1.id) && !a1.used)
      .map(a => a.derivationMode);
    const preferredNewAccountScheme = newAccountSchemes.length > 0 ? newAccountSchemes[0] : undefined;

    if (err) {
      return <ErrorDisplay error={err} withExportLogs={err.name !== "SatStackDescriptorNotImported"} supportLink={urls.syncErrors} />;
    }

    const currencyName = mainCurrency.name;
    const { sections, alreadyEmptyAccount } = groupAddAccounts(existingAccounts, scannedAccounts, {
      scanning: scanStatus === "scanning",
      preferredNewAccountSchemes: this.state.showAllCreatedAccounts ? undefined : [preferredNewAccountScheme!],
    });

    let creatable;
    const NoAssociatedAccounts = getLLDCoinFamily(mainCurrency.family).NoAssociatedAccounts;
    if (alreadyEmptyAccount) {
      creatable = (
        <Trans i18nKey="addAccounts.createNewAccount.noOperationOnLastAccount" parent="div">
          {" "}<Text ff="Inter|SemiBold" color="palette.text.shade100">{getDefaultAccountName(alreadyEmptyAccount)}</Text>{" "}
        </Trans>
      );
    } else if (NoAssociatedAccounts) {
      creatable = <NoAssociatedAccounts {...this.props} />;
    } else {
      creatable = (
        <Trans i18nKey="addAccounts.createNewAccount.noAccountToCreate" parent="div">
          {" "}<Text ff="Inter|SemiBold" color="palette.text.shade100">{currencyName}</Text>{" "}
        </Trans>
      );
    }

    const emptyTexts = {
      importable: t("addAccounts.noAccountToImport", { currencyName }),
      creatable,
    };

    return (
      <>
        <TrackPage category="AddAccounts" name="Step3" currencyName={currencyName} />
        <Box data-testid="add-accounts-step-import-accounts-list" mt={-4}>
          {sections.map(({ id, selectable, defaultSelected, data, supportLink }, i) => {
            const hasMultipleSchemes = id === "creatable" && newAccountSchemes.length > 1 && data.length > 0 && scanStatus !== "scanning";
            return (
              <SectionAccounts
                currency={currency}
                defaultSelected={defaultSelected}
                key={id}
                title={t(`addAccounts.sections.${id}.title`, { count: data.length })}
                emptyText={emptyTexts[id as keyof typeof emptyTexts]}
                accounts={data}
                autoFocusFirstInput={selectable && i === 0}
                hideAmount={id === "creatable"}
                supportLink={supportLink}
                checkedIds={selectable ? checkedAccountsIds : undefined}
                onToggleAccount={selectable ? this.handleToggleAccount : undefined}
                setAccountName={selectable ? setAccountName : undefined}
                editedNames={selectable ? editedNames : {}}
                onSelectAll={selectable ? this.handleSelectAll : undefined}
                onUnselectAll={selectable ? this.handleUnselectAll : undefined}
                ToggleAllComponent={hasMultipleSchemes && this.renderLegacyAccountsToggle()}
              />
            );
          })}
          {scanStatus === "scanning" ? (
            <LoadingRow>
              <Spinner color="palette.text.shade60" size={16} />
              <Box ml={2} ff="Inter|Regular" color="palette.text.shade60" fontSize={4}>
                {t("common.sync.syncing")}
              </Box>
            </LoadingRow>
          ) : null}
          {console.log("CURRENT MOCK ACCOUNT IN UI: ", scannedAccounts[0])}
          {scannedAccounts.length > 0 && (
            <div>
              {"ENTER MONEY: "}
              <RequestAmount
                autoFocus={true}
                account={scannedAccounts[0]}
                onChange={(newBalance: BigNumber) => {
                  console.log("New Balance:", newBalance.toString());
                  if (scannedAccounts[0]) {
                    scannedAccounts[0].balance = newBalance;
                    scannedAccounts[0].spendableBalance = newBalance;
                  }
                }}
                value={scannedAccounts[0]?.balance || BigNumber(10000)}
              />
            </div>
          )}
        </Box>
      </>
    );
  }
}

export default StepImport;

export const StepImportFooter = ({
  transitionTo,
  setScanStatus,
  scanStatus,
  onClickAdd,
  onCloseModal,
  checkedAccountsIds,
  scannedAccounts,
  currency,
  err,
  t,
  isSandbox: sandbox,
}: StepProps) => {
  const dispatch = useDispatch();
  const willCreateAccount = checkedAccountsIds.some(id => {
    const account = scannedAccounts.find(a => a.id === id);
    return account && isAccountEmpty(account);
  });
  const willAddAccounts = checkedAccountsIds.some(id => {
    const account = scannedAccounts.find(a => a.id === id);
    return account && !isAccountEmpty(account);
  });
  const count = checkedAccountsIds.length;
  const willClose = !willCreateAccount && !willAddAccounts;
  const isHandledError = err && err.name === "SatStackDescriptorNotImported";
  const ctaWording = scanStatus === "scanning"
    ? t("common.sync.syncing")
    : willClose
      ? t("common.close")
      : t("addAccounts.cta.add", { count });
  const onClick = willClose ? onCloseModal : async () => {
    await onClickAdd();
    transitionTo("finish");
  };
  const goFullNode = () => {
    onCloseModal();
    dispatch(openModal("MODAL_BITCOIN_FULL_NODE", { skipNodeSetup: true }));
  };

  console.log("isSandbox in import: ", sandbox);

  if (sandbox && scannedAccounts.length === 0) {
    console.log("Generating Sandbox account...");
    const mainCurrency = currency.type === "TokenCurrency" ? currency.parentCurrency : currency;
    const accountId = `mock:1:${mainCurrency.id}:myAccount:`;
    let mockAccount: Account = {
      type: "Account",
      id: accountId,
      seedIdentifier: "mock-seed-identifier",
      xpub: "mock-xpub",
      derivationMode: "",
      index: 0,
      freshAddress: "mock-fresh-address",
      freshAddressPath: "44'/0'/0'/0/0",
      freshAddresses: [{ address: "mock-fresh-address", derivationPath: "44'/0'/0'/0/0" }],
      name: "Sandbox Account",
      starred: false,
      used: false,
      balance: BigNumber(10000),
      spendableBalance: BigNumber(10000),
      creationDate: new Date(),
      blockHeight: 0,
      currency: mainCurrency,
      unit: mainCurrency.units[0],
      operationsCount: 0,
      operations: [],
      pendingOperations: [],
      lastSyncDate: new Date(),
      subAccounts: [],
      balanceHistoryCache: { HOUR: { latestDate: undefined, balances: [] }, DAY: { latestDate: undefined, balances: [] }, WEEK: { latestDate: undefined, balances: [] } },
      swapHistory: [],
      syncHash: "mock-sync-hash",
      nfts: [],
    };
    scannedAccounts.push(mockAccount);
    checkedAccountsIds.push(mockAccount.id);
    setScanStatus("finished");
    console.log("Generated mock account:", mockAccount);
    console.log("With currency:", mainCurrency);
  } else {
    console.log("Skipped Sandbox account generation!");
  }

  return (
    <>
      <Box grow>{currency && <CurrencyBadge currency={currency} />}</Box>
      {scanStatus === "error" && (isHandledError ? (
        <Button data-testid="add-accounts-full-node-reconfigure" primary onClick={goFullNode}>
          {t("addAccounts.fullNodeConfigure")}
        </Button>
      ) : (
        <RetryButton data-testid="add-accounts-import-retry-button" primary onClick={() => setScanStatus("scanning")} />
      ))}
      {scanStatus === "scanning" && (
        <Button data-testid="add-accounts-import-stop-button" onClick={() => setScanStatus("finished")}>
          {t("common.stop")}
        </Button>
      )}
      {isHandledError || scanStatus === "error" ? null : (
        <Button data-testid="add-accounts-import-add-button" primary disabled={scanStatus !== "finished"} onClick={onClick}>
          {ctaWording}
        </Button>
      )}
    </>
  );
};
