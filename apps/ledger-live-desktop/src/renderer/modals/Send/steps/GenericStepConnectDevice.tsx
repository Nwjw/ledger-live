import React, { useMemo, useState, useEffect } from "react";
import { Trans } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { Device } from "@ledgerhq/live-common/hw/actions/types";
import DeviceAction from "~/renderer/components/DeviceAction";
import StepProgress from "~/renderer/components/StepProgress";
import { createAction } from "@ledgerhq/live-common/hw/actions/transaction";
import { useBroadcast } from "@ledgerhq/live-common/hooks/useBroadcast";
import { Account, AccountLike, Operation, OperationType, SignedOperation, isSandbox } from "@ledgerhq/types-live";
import { Transaction, TransactionStatus } from "@ledgerhq/live-common/generated/types";
import { getEnv } from "@ledgerhq/live-env";
import { mockedEventEmitter } from "~/renderer/components/debug/DebugMock";
import { DeviceBlocker } from "~/renderer/components/DeviceAction/DeviceBlocker";
import { closeModal } from "~/renderer/actions/modals";
import { mevProtectionSelector } from "~/renderer/reducers/settings";
import connectApp from "@ledgerhq/live-common/hw/connectApp";
import BigNumber from "bignumber.js";
import { DeviceModelId } from "@ledgerhq/devices";

const action = createAction(getEnv("MOCK") ? mockedEventEmitter : connectApp);

const Result = (
  props:
    | { signedOperation: SignedOperation | undefined | null; device: Device }
    | { transactionSignError: Error },
) => {
  if (!("signedOperation" in props)) return null;
  return (
    <StepProgress>
      <DeviceBlocker />
      <Trans i18nKey="send.steps.confirmation.pending.title" />
    </StepProgress>
  );
};

const mockOperationBase: Operation = {
  id: "sandbox-tx-1",
  hash: "mock-tx-hash-1",
  type: "OUT" as OperationType,
  value: new BigNumber(0), // Overridden by transaction.amount
  fee: new BigNumber(0),
  senders: [],
  recipients: [],
  blockHeight: 1000,
  blockHash: "mock-block-hash",
  transactionSequenceNumber: 0,
  accountId: "",
  date: new Date("2025-03-01"),
  hasFailed: false,
  subOperations: [],
  internalOperations: [],
  nftOperations: [],
  transactionRaw: undefined,
  extra: {},
};

export default function StepConnectDevice({
  account,
  parentAccount,
  transaction,
  status,
  transitionTo,
  onOperationBroadcasted,
  onTransactionError,
  setSigned,
  onConfirmationHandler,
  onFailHandler,
}: {
  transitionTo: (a: string) => void;
  account?: AccountLike | undefined | null;
  parentAccount?: Account | undefined | null;
  transaction?: Transaction | undefined | null;
  status: TransactionStatus;
  onTransactionError: (a: Error) => void;
  onOperationBroadcasted: (a: Operation) => void;
  setSigned: (a: boolean) => void;
  onConfirmationHandler?: Function;
  onFailHandler?: Function;
}) {
  const mevProtected = useSelector(mevProtectionSelector);
  const dispatch = useDispatch();
  const broadcastConfig = useMemo(() => ({ mevProtected }), [mevProtected]);
  const broadcast = useBroadcast({ account, parentAccount, broadcastConfig });
  const tokenCurrency = (account && account.type === "TokenAccount" && account.token) || undefined;
  const request = useMemo(
    () => ({ tokenCurrency, parentAccount, account, transaction, status }),
    [account, parentAccount, status, tokenCurrency, transaction],
  );
  const [operationAdded, setOperationAdded] = useState(false);

  if (!transaction || !account) return null;

  function onResult(result: any) {
    if ("signedOperation" in result) {
      const { signedOperation } = result;
      setSigned(true);
      broadcast(signedOperation).then(
        operation => {
          if (operationAdded) return;
          if (account && isSandbox(account)) {
            const fixedOp: Operation = {
              ...operation,
              id: `sandbox-${account.id}-tx-${Date.now()}`, // Unique ID
              hash: "mock-tx-hash-1",
              type: "OUT",
              value: transaction.amount,
              fee: status.estimatedFees || new BigNumber(0),
              date: new Date("2025-03-01"),
              blockHeight: 1000,
              blockHash: "mock-block-hash",
              transactionSequenceNumber: 0,
              senders: [account.id],
              recipients: transaction.recipients || [],
            };
            account.operations.push(fixedOp);
            account.pendingOperations.push(fixedOp);
            account.balance = account.balance.minus(transaction.amount.plus(status.estimatedFees || 0));
            setOperationAdded(true);
            console.log("Broadcasted Operation:", fixedOp);
            console.log("Operations:", account.operations);
            console.log("Pending Operations:", account.pendingOperations);
            console.log("Updated Balance:", account.balance.toString());
          }
          if (!onConfirmationHandler) {
            onOperationBroadcasted(operation);
            transitionTo("confirmation");
          } else {
            dispatch(closeModal("MODAL_SEND"));
            onConfirmationHandler(operation);
          }
        },
        error => {
          if (!onFailHandler) {
            onTransactionError(error);
            transitionTo("confirmation");
          } else {
            dispatch(closeModal("MODAL_SEND"));
            onFailHandler(error);
          }
        },
      );
    } else if ("transactionSignError" in result) {
      const { transactionSignError } = result;
      if (!onFailHandler) {
        onTransactionError(transactionSignError);
        transitionTo("confirmation");
      } else {
        dispatch(closeModal("MODAL_SEND"));
        onFailHandler(transactionSignError);
      }
    }
  }

  if (isSandbox(account)) {
    const mockOperation: SignedOperation = {
      operation: {
        ...mockOperationBase,
        id: `sandbox-${account.id}-tx-${Date.now()}`,
        accountId: account.id,
        value: transaction.amount,
        fee: status.estimatedFees || new BigNumber(0),
        senders: [account.id],
        recipients: transaction.recipients || [],
      },
      signature: "mock-signature",
    };
    const mockResult = {
      signedOperation: mockOperation,
      device: { deviceId: "", wired: true, modelId: DeviceModelId.nanoS },
      transactionSignError: undefined,
    };
    onResult(mockResult);
  }

  useEffect(() => {
    setOperationAdded(false); // Reset on account or transaction change
  }, [account?.id, transaction?.amount]);

  return (
    <DeviceAction
      action={action}
      request={request}
      Result={Result}
      onResult={onResult}
      analyticsPropertyFlow="send"
    />
  );
}
