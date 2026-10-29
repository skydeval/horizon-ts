import {Component, type ErrorInfo, type ReactNode} from 'react'
import {ScrollView, type StyleProp, type ViewStyle} from 'react-native'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'

import {logger} from '#/logger'
import {type Metadata} from '#/logger/types'
import {ErrorStack} from '#/horizon/errors/ErrorStack'
import {SHOW_ERROR_STACK} from '#/horizon/switches'
import {ErrorScreen} from './error/ErrorScreen'
import {CenteredView} from './Views'

interface Props {
  children?: ReactNode
  renderError?: (error: any) => ReactNode
  getErrorMetadata?: (error: Error) => Metadata
  style?: StyleProp<ViewStyle>
}

interface State {
  hasError: boolean
  error: any
  // HORIZON: shown under the message in test builds (SHOW_ERROR_STACK)
  componentStack?: string
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: undefined,
  }

  public static getDerivedStateFromError(error: Error): State {
    return {hasError: true, error}
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(error, {
      errorInfo,
      ...this.props.getErrorMetadata?.(error),
    })
    // HORIZON: kept for the stack shown in test builds
    if (SHOW_ERROR_STACK) {
      this.setState({componentStack: errorInfo.componentStack ?? undefined})
    }
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.renderError) {
        return this.props.renderError(this.state.error)
      }

      return (
        <CenteredView style={[{height: '100%', flex: 1}, this.props.style]}>
          {/* HORIZON: scrolls, with the crash's stack below in test builds */}
          <ScrollView>
            <TranslatedErrorScreen details={this.state.error.toString()} />
            {SHOW_ERROR_STACK && (
              <ErrorStack
                error={this.state.error}
                componentStack={this.state.componentStack}
              />
            )}
          </ScrollView>
        </CenteredView>
      )
    }

    return this.props.children
  }
}

function TranslatedErrorScreen({details}: {details?: string}) {
  const {_} = useLingui()

  return (
    <ErrorScreen
      title={_(msg`Oh no!`)}
      message={_(
        msg`There was an unexpected issue in the application. Please let us know if this happened to you!`,
      )}
      details={details}
    />
  )
}
